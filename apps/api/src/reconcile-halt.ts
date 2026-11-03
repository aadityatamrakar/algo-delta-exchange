/**
 * THE EXCHANGE RECONCILIATION HALT (lane A, 3 Nov): what the positions
 * comparison DOES about a verdict, rather than only displaying it.
 *
 *   - LIVE, the desk and the exchange disagree on any contract for
 *     `HALT_AFTER_PASSES` (2) consecutive passes → new opens are halted on the
 *     live rail (a kill switch scoped `'live'`: closes still go, paper and the
 *     demo rail trade on) and a CRITICAL alert names the contracts. Clearing
 *     is the operator's, through the existing kill-switch release.
 *   - The first mismatched pass is a WARN: one pass is as likely to be a fill
 *     in flight between the two reads as a real divergence.
 *   - DEMO: alerts only (warn), never a halt, so the demo keeps testing.
 *   - NO VERDICT (no snapshot, a stale one, an unparseable row) is NEVER a
 *     mismatch. It is a WARN when the desk believes it holds something on that
 *     rail — a desk that cannot see the exchange it is short on — and it
 *     neither advances nor resets the count: a blind pass is no evidence
 *     either way. Nothing at all on the simulator, which has no exchange.
 *
 * ONE HALT PER EPISODE. Once halted for a set of divergent contracts, the
 * same set does not engage the halt again — the operator may have released it
 * on purpose, knowing why — while the critical alert keeps being raised (the
 * sink dedupes it to one per 10 minutes). An agreeing pass ends the episode; a
 * different set of contracts is a new one. An operator's halt already in
 * force is never overwritten (`halt` answers `'already'`).
 */
import { DESK_ALERTS_COLLECTION, createAlertSink, type DeskAlert } from '@algomaker/core'
import { SIMULATOR_NO_COMPARE, type CompareRail, type PositionsCompareReport } from './positions-compare.ts'
import type { ApiDeps } from './routes/kit.ts'

export const HALT_AFTER_PASSES = 2

export interface ReconcileHaltPorts {
  alert(alert: DeskAlert): void
  /**
   * Engage the LIVE-scoped halt with this reason. `'already'` when a halt was
   * already in force (left exactly as it was). Absent on the demo rail.
   */
  halt?(reason: string): Promise<'engaged' | 'already'>
  log(msg: string, ctx?: Record<string, unknown>): void
}

/**
 * The real ports: `desk-alerts` through the shared writer, and — LIVE only —
 * the kill switch, engaged scoped to the live rail unless any halt is already
 * in force. `setBy: 'positions-compare'` names who engaged it on the Controls
 * card; the operator's release (password-gated) is the only way it clears.
 */
export function reconcileHaltFor(deps: Pick<ApiDeps, 'db' | 'store' | 'now' | 'log'>, rail: CompareRail): ReconcileHalt {
  const alert = createAlertSink(deps.db.collection(DESK_ALERTS_COLLECTION) as never, {
    now: () => deps.now(),
    log: (message) => deps.log(message),
  })
  return new ReconcileHalt(
    {
      alert,
      log: deps.log,
      ...(rail !== 'live'
        ? {}
        : {
            halt: async (reason: string): Promise<'engaged' | 'already'> => {
              const current = await deps.store.loadKillSwitch()
              if (current.enabled) return 'already'
              await deps.store.saveKillSwitch({
                enabled: true,
                reason,
                setBy: 'positions-compare',
                setAt: deps.now(),
                scope: 'live',
              })
              return 'engaged'
            },
          }),
    },
    rail,
  )
}

export class ReconcileHalt {
  readonly #p: ReconcileHaltPorts
  readonly #rail: CompareRail
  #streak = 0
  /** The divergent set the halt was last engaged for, '' = none this episode. */
  #haltedFor = ''

  constructor(ports: ReconcileHaltPorts, rail: CompareRail) {
    this.#p = ports
    this.#rail = rail
  }

  async observe(report: PositionsCompareReport): Promise<void> {
    const mode = this.#rail === 'live' ? 'live' : 'paper'
    const base = { source: 'api', mode } as const
    const keyOf = (what: string): string => `positions-compare:${this.#rail}:${what}`
    const railWord = this.#rail === 'live' ? 'LIVE' : 'demo'

    if (!report.comparable) {
      if (report.reason === SIMULATOR_NO_COMPARE) return
      const held = report.symbols.filter((s) => s.books + s.ledger !== 0)
      if (held.length === 0) return
      this.#p.alert({
        ...base,
        severity: 'warn',
        key: keyOf('no-verdict'),
        message:
          `${railWord} positions vs the exchange: no verdict — ${report.reason}. The desk holds ` +
          `${held.length} contract(s) it cannot check against the exchange; this is not read as a mismatch`,
      })
      return
    }
    if (report.divergent.length === 0) {
      this.#streak = 0
      this.#haltedFor = ''
      return
    }

    this.#streak += 1
    const signature = [...report.divergent].sort().join(',')
    const differing = report.symbols
      .filter((s) => !s.agree)
      .map((s) => `${s.symbol}: desk ${s.books + s.ledger} vs exchange ${s.broker ?? 0}`)
      .join('; ')

    if (this.#rail !== 'live' || this.#p.halt === undefined) {
      this.#p.alert({
        ...base,
        severity: 'warn',
        key: keyOf('mismatch'),
        message: `${railWord} positions differ from the exchange (${this.#streak} pass(es)) — ${differing}. Alert only: the ${railWord} rail is not halted`,
      })
      return
    }
    if (this.#streak < HALT_AFTER_PASSES) {
      this.#p.alert({
        ...base,
        severity: 'warn',
        key: keyOf('mismatch'),
        message: `LIVE positions differ from the exchange — ${differing}. One more pass like this halts new live opens`,
      })
      return
    }

    let outcome: string
    if (this.#haltedFor === signature) {
      outcome = 'new live opens were halted for these contracts already (release from Controls once reconciled)'
    } else {
      this.#haltedFor = signature
      const reason = `positions differ from the exchange for ${this.#streak} passes: ${differing}`
      try {
        const done = await this.#p.halt(reason)
        outcome =
          done === 'engaged'
            ? 'NEW LIVE OPENS ARE HALTED (closes still go) until the operator releases the kill switch'
            : 'a halt was already in force and has been left as it was'
        this.#p.log('positions compare: LIVE mismatch — halt', { divergent: report.divergent, outcome: done })
      } catch (err) {
        this.#haltedFor = ''
        outcome = `the halt could NOT be engaged (${err instanceof Error ? err.message : String(err)}) — halt live by hand`
        this.#p.log('positions compare: LIVE mismatch — the halt could not be engaged', {
          divergent: report.divergent,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.#p.alert({
      ...base,
      severity: 'critical',
      key: keyOf('halt'),
      message: `LIVE positions differ from the exchange for ${this.#streak} consecutive passes — ${differing}. ${outcome}`,
    })
  }
}
