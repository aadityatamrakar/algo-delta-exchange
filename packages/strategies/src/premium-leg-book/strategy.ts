import { StrategyBase, cronAtIstMinute, type JobSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Quote, StrategyContext, InstrumentRef } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import { clearSessionState, loadSessionState, saveSessionState } from '../session-state.ts'
import type { PremiumLegBookConfig } from './config.ts'

interface LegGroup {
  readonly atm: number
  readonly ceInstrument: InstrumentRef
  readonly peInstrument: InstrumentRef
  readonly ceEntry: number
  readonly peEntry: number
  readonly lots: number
  readonly combinedTrigger: number
  readonly ceTrigger: number
  readonly peTrigger: number
  // C3: status is tracked PER LEG, not per group. lion-s25-2.js:143-160 keeps CE and PE as
  // two INDEPENDENT entries in optionOrders — one leg stopping never affects the other's own
  // trigger check. A single group-level status let one leg's stop mark the WHOLE group
  // 'CLOSED', which then made #checkStops skip it forever and squareOff never visit it,
  // silently orphaning the surviving short leg for the rest of the session.
  ceStatus: 'ACTIVE' | 'CLOSED'
  peStatus: 'ACTIVE' | 'CLOSED'
}

/**
 * What a mid-session restart has to get back.
 *
 * `groups` carries the per-leg entry premiums and stop triggers as well as the
 * instruments — recomputing them from the CURRENT premium would move every stop
 * to wherever the market happens to be at restart, which on a short-premium book
 * means a stop that has already been breached silently becomes a stop that has
 * not. `currentSize` is the pyramid ladder (D9: `cap: null` grows forever, and
 * that null is the owner's chosen behaviour), so losing it drops the next group
 * back to `sizing.start`. `openAtms` is the once-per-ATM gate: without it the
 * next crossover through an ATM that already has a live group opens a duplicate
 * group on top of it.
 *
 * `openAtms` is a Set in memory and an array here — a Set does not survive JSON.
 *
 * `lastPrice` is deliberately absent, for the same reason as in
 * premium-distance-accumulator: it changes every tick, and `#reBaseline` costs
 * one tick instead of a store write per tick.
 */
interface PersistedSession {
  readonly currentSize: number
  readonly groups: readonly LegGroup[]
  readonly openAtms: readonly number[]
}

export class PremiumLegBookStrategy extends StrategyBase {
  readonly #cfg: PremiumLegBookConfig
  #lastPrice = 0
  #currentSize: number
  #groups: LegGroup[] = []
  #openAtms = new Set<number>()
  /**
   * Set by `onRecover()`. The first ref tick after a restart only re-seeds
   * `#lastPrice`, so `isCrossover(spot, 0, atm)` cannot report a crossover that
   * never happened and open a group on top of the recovered book. Stops are NOT
   * skipped — `#checkStops` runs on that tick as usual, because delaying an exit
   * is the one thing a recovery must never do.
   */
  #reBaseline = false

  constructor(ctx: StrategyContext, cfg: PremiumLegBookConfig) {
    super(ctx)
    this.#cfg = cfg
    this.#currentSize = cfg.sizing.kind === 'pyramid-up' ? cfg.sizing.start : 1
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#lastPrice = 0
    this.#currentSize = this.#cfg.sizing.kind === 'pyramid-up' ? this.#cfg.sizing.start : 1
    this.#groups = []
    this.#openAtms.clear()
  }

  /**
   * Put back what `onDayStart()` just wiped. Runs before job catch-up.
   *
   * Recovering the groups is what re-arms `#checkStops`: every stop this book
   * has is evaluated per tick against `#groups`, so an unrecovered group is a
   * short leg with no stop AND no square-off.
   */
  protected override async onRecover(): Promise<void> {
    const snap = await loadSessionState<PersistedSession>(this.ctx)
    if (snap === null) return
    this.#currentSize = snap.currentSize
    this.#groups = snap.groups.map((g) => ({ ...g }))
    this.#openAtms = new Set(snap.openAtms)
    this.#reBaseline = true
    const open = this.#groups.filter((g) => g.ceStatus === 'ACTIVE' || g.peStatus === 'ACTIVE')
    this.ctx.log.info(`${this.tag}: recovered session state`, {
      groups: snap.groups.length,
      openGroups: open.length,
      currentSize: snap.currentSize,
      openAtms: snap.openAtms.join(','),
    })
  }

  /**
   * The backstop for every square-off path — day-end job, operator switch-off,
   * session rollover, SIGTERM. All silent no-ops before this existed, on a class
   * whose entire book is SHORT premium.
   */
  protected override async onDayEnd(reason: string): Promise<void> {
    if (this.#anyLegOpen()) this.ctx.log.info(`${this.tag}: day end (${reason}) — flattening`)
    await this.#flattenAll()
    if (!this.#anyLegOpen()) {
      await clearSessionState(this.ctx)
      return
    }
    this.ctx.log.error(`${this.tag}: day-end flatten did not complete — state kept for recovery`, {
      stillOpen: this.#groups
        .flatMap((g) => [
          ...(g.ceStatus === 'ACTIVE' ? [g.ceInstrument.tradingsymbol] : []),
          ...(g.peStatus === 'ACTIVE' ? [g.peInstrument.tradingsymbol] : []),
        ])
        .join(','),
    })
  }

  #anyLegOpen(): boolean {
    return this.#groups.some((g) => g.ceStatus === 'ACTIVE' || g.peStatus === 'ACTIVE')
  }

  /** Snapshot at the point of change, never at the end of a tick. */
  async #persist(): Promise<void> {
    await saveSessionState<PersistedSession>(this.ctx, {
      currentSize: this.#currentSize,
      groups: this.#groups,
      openAtms: [...this.#openAtms],
    })
  }

  /**
   * C3: flatten every leg still open, per leg — not just groups whose OTHER leg
   * never stopped. A group with one leg already closed by its own stop must still
   * have its surviving leg flattened here.
   *
   * Shared by `onDayEnd` and the `squareOff` job, so the two are the same code
   * and idempotent against each other: a leg the cron already bought back is
   * `CLOSED` and the day-end skips it.
   */
  async #flattenAll(): Promise<void> {
    for (const g of this.#groups) {
      if (g.ceStatus === 'ACTIVE') await this.#flattenLeg(g, 'CE')
      if (g.peStatus === 'ACTIVE') await this.#flattenLeg(g, 'PE')
    }
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
        run: async () => {
          await this.#flattenAll()
        },
      },
    ]
  }

  protected override async onTick(quote: Quote): Promise<void> {
    // I5 (assessed, not changed): lion-s25-2.js:94-109 runs placeTrade() on EVERY ticks
    // batch, not gated on the batch containing a future tick — but it always reads the
    // future's price from ITS OWN cache, so re-evaluating on an option tick with an
    // unchanged cached future price recomputes isCrossover(x, x, atm), which cannot newly
    // cross anything it hasn't already been checked against. Gating this on
    // `quote.token === refToken` is therefore order-emission-equivalent, not a behaviour
    // gap — widening it to read ctx.md.quote(refToken) on every tick was tried and reverted:
    // it silently breaks every test that drives handleTick() with a tick payload but no
    // separate ctx.md.setQuote() seed (a pattern used throughout this suite), for zero
    // observable difference in emitted orders.
    const refToken = this.#refToken()
    if (quote.token === refToken) {
      if (this.#reBaseline) {
        // First ref tick after a restart: seed the baseline only. See `#reBaseline`.
        this.#reBaseline = false
        this.#lastPrice = quote.lastPrice
      } else {
        const atm = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, quote.lastPrice)
        if (logic.isCrossover(quote.lastPrice, this.#lastPrice, atm) && !this.#openAtms.has(atm)) {
          await this.#openGroup(atm)
        }
        this.#lastPrice = quote.lastPrice
      }
    }
    await this.#checkStops()
  }

  #refToken(): number {
    return this.#cfg.underlying.reference === 'current-future'
      ? (this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol))
      : this.ctx.md.spotToken(this.#cfg.underlying.symbol)
  }

  async #openGroup(atm: number): Promise<void> {
    const ceInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm + this.#cfg.strike.offsetPoints, 'CE')
    const peInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm - this.#cfg.strike.offsetPoints, 'PE')
    if (ceInst === null || peInst === null) return
    const ceQ = this.ctx.md.quote(ceInst.instrumentToken ?? -1)
    const peQ = this.ctx.md.quote(peInst.instrumentToken ?? -1)
    if (ceQ === null || peQ === null) return

    const lots = this.#currentSize
    const ceRes = await this.submit({ instrument: ceInst, side: 'SELL', lots })
    const peRes = await this.submit({ instrument: peInst, side: 'SELL', lots })
    if (!ceRes.accepted || !peRes.accepted) return

    this.#openAtms.add(atm)
    const combinedTrigger = this.#cfg.stop.scope === 'combined'
      ? logic.combinedStopTrigger(ceQ.lastPrice, peQ.lastPrice, this.#cfg.stop.multiplier)
      : 0
    this.#groups.push({
      atm, ceInstrument: ceInst, peInstrument: peInst, ceEntry: ceQ.lastPrice, peEntry: peQ.lastPrice, lots,
      combinedTrigger,
      ceTrigger: this.#cfg.stop.scope === 'per-leg' ? logic.perLegStopTrigger(ceQ.lastPrice, this.#cfg.stop.multiplier) : 0,
      peTrigger: this.#cfg.stop.scope === 'per-leg' ? logic.perLegStopTrigger(peQ.lastPrice, this.#cfg.stop.multiplier) : 0,
      ceStatus: 'ACTIVE', peStatus: 'ACTIVE',
    })
    // D9: pyramid-up with cap: null grows forever — never gate this on risk.maxLotsNet
    // being non-null; that null IS the owner's chosen behaviour.
    if (this.#cfg.sizing.kind === 'pyramid-up') {
      this.#currentSize = logic.nextPyramidSize(this.#currentSize, this.#cfg.sizing.step, this.#cfg.sizing.cap)
    }
    // Two live shorts, their entry premiums, their stop triggers, the ATM gate
    // and the stepped pyramid size — all in one write, because they are only
    // correct together.
    await this.#persist()
  }

  async #checkStops(): Promise<void> {
    for (const g of this.#groups) {
      if (g.ceStatus !== 'ACTIVE' && g.peStatus !== 'ACTIVE') continue
      const ceQ = this.ctx.md.quote(g.ceInstrument.instrumentToken ?? -1)
      const peQ = this.ctx.md.quote(g.peInstrument.instrumentToken ?? -1)
      if (this.#cfg.stop.scope === 'combined') {
        if (ceQ === null || peQ === null) continue
        if (g.combinedTrigger <= ceQ.lastPrice + peQ.lastPrice) await this.#closeGroup(g)
      } else {
        // C3: each leg's OWN trigger, gated on that leg's OWN status — a leg that already
        // stopped (or was never open) must not be re-evaluated, but the surviving leg must
        // keep being checked every tick regardless of what happened to its sibling.
        if (g.ceStatus === 'ACTIVE' && ceQ !== null && ceQ.lastPrice > g.ceTrigger) await this.#closeLeg(g, 'CE')
        if (g.peStatus === 'ACTIVE' && peQ !== null && peQ.lastPrice > g.peTrigger) await this.#closeLeg(g, 'PE')
      }
    }
  }

  async #closeGroup(g: LegGroup): Promise<void> {
    // Order preserved (PE then CE) — sequencing is part of what the golden diff
    // compares. Each leg's status now follows its OWN result rather than both
    // being marked closed off two unchecked submits.
    const peRes = await this.submit({ instrument: g.peInstrument, side: 'BUY', lots: g.lots, reducesExposure: true })
    const ceRes = await this.submit({ instrument: g.ceInstrument, side: 'BUY', lots: g.lots, reducesExposure: true })
    if (ceRes.accepted) g.ceStatus = 'CLOSED'
    if (peRes.accepted) g.peStatus = 'CLOSED'
    this.#openAtms.delete(g.atm)
    await this.#persist()
  }

  async #closeLeg(g: LegGroup, leg: 'CE' | 'PE'): Promise<void> {
    await this.#flattenLeg(g, leg)
    if (this.#cfg.reentry === 'per-leg') {
      // lion-s25-2.js re-adds only the stopped leg at the CURRENT atm on the next crossover;
      // modelled here by simply clearing this group's open-atm gate so #openGroup can re-fire.
      this.#openAtms.delete(g.atm)
      await this.#persist()
    }
  }

  /**
   * Submit the closing BUY for exactly one leg and mark THAT leg's own status
   * closed — but only if the order was ACCEPTED.
   *
   * Marking it closed unconditionally is how a refused buy-back becomes an
   * invisible naked short: `#checkStops` skips non-ACTIVE legs and `#flattenAll`
   * skips them too, so nothing would ever try again. Leaving it ACTIVE means the
   * next tick's stop check and the day-end backstop both retry it, and the
   * persisted record keeps saying the leg is open.
   */
  async #flattenLeg(g: LegGroup, leg: 'CE' | 'PE'): Promise<void> {
    const inst = leg === 'CE' ? g.ceInstrument : g.peInstrument
    const res = await this.submit({ instrument: inst, side: 'BUY', lots: g.lots, reducesExposure: true })
    if (res.accepted) {
      if (leg === 'CE') g.ceStatus = 'CLOSED'
      else g.peStatus = 'CLOSED'
    }
    await this.#persist()
  }
}
