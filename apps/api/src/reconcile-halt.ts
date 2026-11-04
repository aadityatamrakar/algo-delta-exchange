/**
 * THE EXCHANGE RECONCILIATION HALT (lane A, 3 Nov): what the positions
 * comparison DOES about a verdict, rather than only displaying it.
 *
 *   - LIVE, the desk and the exchange disagree on THE SAME contract for
 *     `HALT_AFTER_PASSES` (2) consecutive passes → new opens are halted on the
 *     live rail (a kill switch scoped `'live'`: closes still go, paper and the
 *     demo rail trade on) and a CRITICAL alert names those contracts. Clearing
 *     is the operator's, through the existing kill-switch release.
 *   - The first mismatched pass is a WARN: one pass is as likely to be a fill
 *     in flight between the two reads as a real divergence.
 *
 * A PASS IS A BROKER SNAPSHOT, AND THE COUNT IS PER CONTRACT (4 Nov). Three
 * callers run the comparison — its own minute, the mirror sync, the Positions
 * page — and the gateway rewrites the snapshot only every 30 s. At 15:01:19
 * two of them read the SAME 15:00:56 snapshot 55 ms apart, and "2 consecutive
 * passes" halted live opens between the two legs of a straddle: the put went,
 * the call was refused. At 14:41 the halt fired on two passes that named
 * DIFFERENT legs — each a straddle opened just after its snapshot. So each
 * contract keeps its own run, which a second read of an already-counted
 * snapshot does not lengthen, which an agreeing verdict on that contract ends,
 * and which a pass with that contract in flight leaves exactly as it was.
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
import {
  SIMULATOR_NO_COMPARE,
  type CompareRail,
  type PositionsCompareReport,
  type SymbolCompare,
} from './positions-compare.ts'
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

/** One contract's run of mismatched passes. */
interface Run {
  /** Consecutive broker snapshots this contract has disagreed on. */
  readonly passes: number
  /** The snapshot (`brokerAsOf`) last counted: reading it again adds nothing. */
  readonly snapshotAt: number
}

export class ReconcileHalt {
  readonly #p: ReconcileHaltPorts
  readonly #rail: CompareRail
  /** Per contract, its current run. Absent = it agrees (or was never seen). */
  readonly #runs = new Map<string, Run>()
  /** The contract set the halt was last engaged for, '' = none this episode. */
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
    // Each contract's run moves on its own evidence. A leg in flight
    // (`IN_FLIGHT_GRACE_MS`) is no verdict on that leg: its run neither moves
    // nor ends, or a desk trading a leg that really diverges could keep
    // resetting the halt it should reach.
    const snapshotAt = report.brokerAsOf ?? report.asOf
    const divergent = new Set(report.divergent)
    const inFlight = new Set(report.symbols.filter((s) => s.inFlight === true).map((s) => s.symbol))
    for (const symbol of [...this.#runs.keys()]) {
      if (!divergent.has(symbol) && !inFlight.has(symbol)) this.#runs.delete(symbol)
    }
    for (const symbol of divergent) {
      const run = this.#runs.get(symbol)
      if (run?.snapshotAt === snapshotAt) continue
      this.#runs.set(symbol, { passes: (run?.passes ?? 0) + 1, snapshotAt })
    }
    if (this.#runs.size === 0) this.#haltedFor = ''
    if (divergent.size === 0) return

    const passesOf = (symbol: string): number => this.#runs.get(symbol)?.passes ?? 0
    const describe = (rows: readonly SymbolCompare[]): string =>
      rows.map((s) => `${s.symbol}: desk ${s.books + s.ledger} vs exchange ${s.broker ?? 0}`).join('; ')
    const differingRows = report.symbols.filter((s) => !s.agree)
    const differing = describe(differingRows)

    if (this.#rail !== 'live' || this.#p.halt === undefined) {
      const most = Math.max(...differingRows.map((s) => passesOf(s.symbol)))
      this.#p.alert({
        ...base,
        severity: 'warn',
        key: keyOf('mismatch'),
        message: `${railWord} positions differ from the exchange (${most} pass(es)) — ${differing}. Alert only: the ${railWord} rail is not halted`,
      })
      return
    }
    const persisting = differingRows.filter((s) => passesOf(s.symbol) >= HALT_AFTER_PASSES)
    if (persisting.length === 0) {
      this.#p.alert({
        ...base,
        severity: 'warn',
        key: keyOf('mismatch'),
        message:
          `LIVE positions differ from the exchange — ${differing}. One more pass showing the same ` +
          'contract(s) halts new live opens',
      })
      return
    }

    const passes = Math.min(...persisting.map((s) => passesOf(s.symbol)))
    const signature = persisting
      .map((s) => s.symbol)
      .sort()
      .join(',')
    const named = describe(persisting)
    const once = differingRows.filter((s) => passesOf(s.symbol) < HALT_AFTER_PASSES)
    const alsoOnce = once.length === 0 ? '' : ` (differing on this pass only, not counted toward the halt: ${describe(once)})`

    let outcome: string
    if (this.#haltedFor === signature) {
      outcome = 'new live opens were halted for these contracts already (release from Controls once reconciled)'
    } else {
      this.#haltedFor = signature
      const reason = `positions differ from the exchange for ${passes} passes: ${named}`
      try {
        const done = await this.#p.halt(reason)
        outcome =
          done === 'engaged'
            ? 'NEW LIVE OPENS ARE HALTED (closes still go) until the operator releases the kill switch'
            : 'a halt was already in force and has been left as it was'
        this.#p.log('positions compare: LIVE mismatch — halt', { divergent: signature.split(','), outcome: done })
      } catch (err) {
        this.#haltedFor = ''
        outcome = `the halt could NOT be engaged (${err instanceof Error ? err.message : String(err)}) — halt live by hand`
        this.#p.log('positions compare: LIVE mismatch — the halt could not be engaged', {
          divergent: signature.split(','),
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.#p.alert({
      ...base,
      severity: 'critical',
      key: keyOf('halt'),
      message: `LIVE positions differ from the exchange for ${passes} consecutive passes — ${named}. ${outcome}${alsoOnce}`,
    })
  }
}
