import { StrategyBase, cronAtIstMinute, type JobSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Quote, StrategyContext, InstrumentRef } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import { clearSessionState, loadSessionState, saveSessionState } from '../session-state.ts'
import type { PremiumDistanceAccumulatorConfig } from './config.ts'

interface OpenLeg {
  readonly instrument: InstrumentRef
  readonly side: 'CE' | 'PE'
}

/**
 * What a mid-session restart has to get back.
 *
 * All four fields, not just the legs. This strategy has exactly ONE exit path by
 * design (D9 — a central flatten, never a per-leg stop), so `legs` IS the book:
 * lose it and every short leg it sold is orphaned with nothing that can ever buy
 * it back. `pending` is the accumulation ladder — losing it silently converts a
 * strategy that keeps adding legs as the future travels into one that opened a
 * straddle at 09:20 and then did nothing for the rest of the day. `entered` is
 * the once-a-day gate: without it the next ATM crossover re-opens the initial
 * straddle ON TOP of the one already live.
 *
 * `lastPrice` is deliberately NOT here. It is the other half of every crossover
 * and trigger test, it changes on every single tick, and neither available
 * treatment is safe: persisting it per tick is a store write per tick, while
 * persisting it only at event points leaves it hours stale — and a stale `prev`
 * widens `triggerCrossed(trigger, prev, cur)` into a window that fires EVERY
 * pending trigger at once, which on an accumulator means a cascade of new short
 * legs in a single tick. `#reBaseline` below handles it instead.
 */
interface PersistedSession {
  readonly entered: boolean
  readonly pending: readonly logic.PendingTrigger[]
  readonly legs: readonly OpenLeg[]
}

export class PremiumDistanceAccumulatorStrategy extends StrategyBase {
  readonly #cfg: PremiumDistanceAccumulatorConfig
  #lastPrice = 0
  #entered = false
  #pending: logic.PendingTrigger[] = []
  #legs: OpenLeg[] = []
  /**
   * Set by `onRecover()`. The FIRST tick after a restart only re-seeds
   * `#lastPrice` and evaluates nothing.
   *
   * `#lastPrice` is not recoverable (see `PersistedSession`), and the two wrong
   * answers both trade: a recovered 0 makes `triggerCrossed(t, 0, spot)` true for
   * every pending trigger simultaneously, and a stale saved value does the same
   * thing over a smaller range. Skipping exactly one tick costs at most one
   * deferred trigger — the accumulator's own design already defers a trigger to
   * the next tick (see the C1 snapshot note in `onTick`) — and it cannot open a
   * position that should not exist.
   */
  #reBaseline = false

  constructor(ctx: StrategyContext, cfg: PremiumDistanceAccumulatorConfig) {
    super(ctx)
    this.#cfg = cfg
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#lastPrice = 0
    this.#entered = false
    this.#pending = []
    this.#legs = []
  }

  /**
   * Put back what `onDayStart()` just wiped. Runs before job catch-up, so the
   * recovered `entered` flag is already in place when a replay would otherwise
   * re-arm the day.
   */
  protected override async onRecover(): Promise<void> {
    const snap = await loadSessionState<PersistedSession>(this.ctx)
    if (snap === null) return
    this.#entered = snap.entered
    this.#pending = [...snap.pending]
    this.#legs = [...snap.legs]
    this.#reBaseline = true
    this.ctx.log.info(`${this.tag}: recovered session state`, {
      entered: snap.entered,
      openLegs: snap.legs.length,
      pendingTriggers: snap.pending.length,
      symbols: snap.legs.map((l) => l.instrument.tradingsymbol).join(','),
    })
  }

  /**
   * The backstop for every square-off path — day-end job, operator switch-off,
   * session rollover, SIGTERM. All silent no-ops before this existed, which on
   * THIS class meant a short-premium book with no exit whatsoever: its only
   * other exit is the `squareOff` cron, and a process that restarted after
   * 15:24 never fires that at all.
   */
  protected override async onDayEnd(reason: string): Promise<void> {
    if (this.#legs.length > 0) {
      this.ctx.log.info(`${this.tag}: day end (${reason}) — flattening`, { legs: this.#legs.length })
    }
    await this.#flatten()
    if (this.#legs.length === 0) {
      await clearSessionState(this.ctx)
      return
    }
    this.ctx.log.error(`${this.tag}: day-end flatten did not complete — state kept for recovery`, {
      stillOpen: this.#legs.map((l) => l.instrument.tradingsymbol).join(','),
    })
  }

  /** Snapshot at the point of change, never at the end of a tick. */
  async #persist(): Promise<void> {
    await saveSessionState<PersistedSession>(this.ctx, {
      entered: this.#entered,
      pending: this.#pending,
      legs: this.#legs,
    })
  }

  /**
   * Buy back every short leg. The shared body of `onDayEnd` and the `squareOff`
   * job, so the two are the same code and idempotent against each other — a leg
   * bought back by the cron is gone from `#legs` and the day-end sees nothing.
   *
   * A leg whose buy-back was REFUSED stays in `#legs` rather than being dropped
   * wholesale (the old `this.#legs = []`): it is still short at the broker, and
   * forgetting it is how a naked short survives the close.
   */
  async #flatten(): Promise<void> {
    if (this.#legs.length === 0) return
    const survivors: OpenLeg[] = []
    for (const leg of this.#legs) {
      const res = await this.submit({ instrument: leg.instrument, side: 'BUY', lots: 1, reducesExposure: true })
      if (!res.accepted) survivors.push(leg)
    }
    this.#legs = survivors
    await this.#persist()
  }

  /** Anatomy row 20: the base echoes this on start. */
  protected override effectiveConfig(): unknown {
    return this.#cfg
  }

  jobs(): readonly JobSpec[] {
    return [
      {
        name: 'squareOff',
        cron: cronAtIstMinute(this.#cfg.squareOffIstMinute),
        replayable: false,
        // The ONLY exit path this class has, by design (D9) — central flatten,
        // never a per-leg stop.
        run: async () => {
          await this.#flatten()
        },
      },
    ]
  }

  protected override async onTick(quote: Quote): Promise<void> {
    const refToken = this.#refToken()
    if (quote.token !== refToken) return

    // First tick after a restart: seed the baseline and evaluate nothing. See
    // `#reBaseline`.
    if (this.#reBaseline) {
      this.#reBaseline = false
      this.#lastPrice = quote.lastPrice
      return
    }

    if (!this.#entered) {
      const atm = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, quote.lastPrice)
      if (logic.isCrossover(quote.lastPrice, this.#lastPrice, atm)) await this.#enterInitial(atm, quote.lastPrice)
      this.#lastPrice = quote.lastPrice
      return
    }

    // C1: snapshot before iterating. Legacy's optionOrders.forEach (eagle-s-1.js:182) caps
    // at the pre-iteration length and defers any newly pushed trigger to the NEXT tick's
    // checkSL() call. A plain `for...of this.#pending` does NOT have that property — Array
    // iterators visit elements appended mid-iteration, and #fireTrigger pushes into
    // this.#pending — so a same-tick trigger cascade would self-feed forever on the same
    // strike (an add_ce fired at futLtp recomputes to a trigger inside the very window that
    // just crossed). Reassigning this.#pending to a fresh array BEFORE iterating `due` means
    // #fireTrigger's pushes land in the fresh array, which is only visited on a LATER tick —
    // exactly matching legacy's deferral.
    const due = this.#pending
    this.#pending = []
    let fired = false
    for (const p of due) {
      if (logic.triggerCrossed(p.trigger, this.#lastPrice, quote.lastPrice)) {
        await this.#fireTrigger(p, quote.lastPrice)
        fired = true
      } else {
        this.#pending.push(p)
      }
    }
    this.#lastPrice = quote.lastPrice
    // Reconcile the ladder once the snapshot loop above has finished, and ONLY
    // on a tick that actually fired. `#fireTrigger` persists the new leg the
    // instant it exists (that is the part that cannot be reconstructed), but
    // while the loop is mid-flight `#pending` is deliberately missing the
    // not-yet-visited tail of `due` — so a write from inside the loop
    // under-records the ladder. Writing again here fixes it. Doing it on EVERY
    // tick instead would be a store round-trip per tick for a field that only
    // changes when a trigger fires.
    if (fired) await this.#persist()
  }

  #refToken(): number {
    return this.#cfg.underlying.reference === 'current-future'
      ? (this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol))
      : this.ctx.md.spotToken(this.#cfg.underlying.symbol)
  }

  async #enterInitial(atm: number, futLtp: number): Promise<void> {
    const ceInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm, 'CE')
    const peInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm, 'PE')
    if (ceInst === null || peInst === null) return
    const ceQ = this.ctx.md.quote(ceInst.instrumentToken ?? -1)
    const peQ = this.ctx.md.quote(peInst.instrumentToken ?? -1)
    if (ceQ === null || peQ === null) return

    const ceRes = await this.submit({ instrument: ceInst, side: 'SELL', lots: 1 })
    const peRes = await this.submit({ instrument: peInst, side: 'SELL', lots: 1 })
    if (!ceRes.accepted || !peRes.accepted) return
    this.#entered = true
    this.#legs.push({ instrument: ceInst, side: 'CE' }, { instrument: peInst, side: 'PE' })
    this.#pending = [...logic.initialTriggers(futLtp, ceQ.lastPrice, peQ.lastPrice)]
    // Both shorts are live at the broker from here on. `entered`, the legs and
    // the ladder go down together: this class has no per-leg stop, so anything
    // lost here can never be bought back.
    await this.#persist()
  }

  async #fireTrigger(p: logic.PendingTrigger, futLtp: number): Promise<void> {
    const side = p.action === 'add_ce' ? 'CE' : 'PE'
    const roundedStrike = side === 'CE' ? Math.ceil(futLtp / this.#cfg.underlying.strikeStep) * this.#cfg.underlying.strikeStep
                                          : Math.floor(futLtp / this.#cfg.underlying.strikeStep) * this.#cfg.underlying.strikeStep
    const inst = this.ctx.md.option(this.#cfg.underlying.symbol, roundedStrike, side)
    if (inst === null) return
    const q = this.ctx.md.quote(inst.instrumentToken ?? -1)
    if (q === null || q.lastPrice <= this.#cfg.premiumFloor) return // permanently prunes this branch

    const res = await this.submit({ instrument: inst, side: 'SELL', lots: 1 })
    if (!res.accepted) return
    this.#legs.push({ instrument: inst, side })
    this.#pending.push(...logic.nextTriggers(p.action, futLtp, q.lastPrice, this.#cfg.premiumFloor))
    await this.#persist()
  }
}
