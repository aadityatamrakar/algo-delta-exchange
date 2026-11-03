import { StrategyBase, cronAtIstMinute, type JobSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Quote, StrategyContext, InstrumentRef } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import { clearSessionState, loadSessionState, saveSessionState } from '../session-state.ts'
import type { MomentumFlipDirectionalConfig } from './config.ts'

/** The open leg as held in memory — the real instrument included, for the exit. */
type HeldLeg = logic.FlipPosition & { readonly instrument: InstrumentRef }

/**
 * What a mid-session restart has to get back.
 *
 * `quantity` is in here because the sizing is a MARTINGALE: it steps up on every
 * re-entry and is capped at `sizing.cap`, which `config.ts` forces to equal
 * `risk.maxLotsNet`. Losing it resets the ladder to `sizing.start`, so a restart
 * after three stop-flips would re-enter at 1 lot instead of 4 and the position
 * that eventually recovers the day's losses is a quarter of the size it should
 * be. `idleForDay` is here because it is the ONLY thing stopping a re-entry after
 * a target has been taken.
 */
interface PersistedSession {
  readonly quantity: number
  readonly frozenAtm: number | null
  readonly position: HeldLeg | null
  readonly idleForDay: boolean
  readonly dayOpen: number | null
}

export class MomentumFlipDirectionalStrategy extends StrategyBase {
  readonly #cfg: MomentumFlipDirectionalConfig
  #quantity: number
  #frozenAtm: number | null = null
  #position: HeldLeg | null = null
  #idleForDay = false
  #dayOpen: number | null = null

  constructor(ctx: StrategyContext, cfg: MomentumFlipDirectionalConfig) {
    super(ctx)
    this.#cfg = cfg
    this.#quantity = cfg.sizing.start
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#quantity = this.#cfg.sizing.start
    this.#frozenAtm = null
    this.#position = null
    this.#idleForDay = false
    this.#dayOpen = null
  }

  /**
   * Put back what `onDayStart()` just wiped. Runs after it, and before job
   * catch-up — which matters here more than anywhere: `bootstrapEntry` is
   * `replayable: false`, so a restart at 09:20 has catch-up SUPPRESS it and rely
   * entirely on what this reads back. Without this hook the suppression is the
   * whole story: the entry never replays and the leg it opened is never
   * recovered, so the position is simply abandoned for the rest of the day.
   */
  protected override async onRecover(): Promise<void> {
    const snap = await loadSessionState<PersistedSession>(this.ctx)
    if (snap === null) return
    this.#quantity = snap.quantity
    this.#frozenAtm = snap.frozenAtm
    this.#position = snap.position
    this.#idleForDay = snap.idleForDay
    this.#dayOpen = snap.dayOpen
    this.ctx.log.info(`${this.tag}: recovered session state`, {
      quantity: snap.quantity,
      frozenAtm: snap.frozenAtm ?? 'none',
      idleForDay: snap.idleForDay,
      position: snap.position === null ? 'none' : `${snap.position.type} ${snap.position.instrument.tradingsymbol} x${snap.position.quantity}`,
    })
  }

  /**
   * The backstop for every square-off path — day-end job, operator switch-off,
   * session rollover, SIGTERM. All of them were silent no-ops before this
   * existed.
   *
   * It flattens and STOPS. It must not go through `#exit('SL')`, which is what
   * the `squareOff` job used to call: that path deliberately flips to the
   * opposite side and RE-ENTERS, so "squaring off" would have closed one leg and
   * opened a brand new one seconds before the market shut.
   */
  protected override async onDayEnd(reason: string): Promise<void> {
    if (this.#position !== null) this.ctx.log.info(`${this.tag}: day end (${reason}) — flattening`)
    await this.#flatten()
    if (this.#position === null) {
      await clearSessionState(this.ctx)
      return
    }
    // A refused exit must not read back as a flat book on the next start.
    this.ctx.log.error(`${this.tag}: day-end flatten did not complete — state kept for recovery`, {
      symbol: this.#position.instrument.tradingsymbol,
    })
  }

  /** Snapshot at the point of change, never at the end of a tick. */
  async #persist(): Promise<void> {
    await saveSessionState<PersistedSession>(this.ctx, {
      quantity: this.#quantity,
      frozenAtm: this.#frozenAtm,
      position: this.#position,
      idleForDay: this.#idleForDay,
      dayOpen: this.#dayOpen,
    })
  }

  /** Anatomy row 20: the base echoes this on start. */
  protected override effectiveConfig(): unknown {
    return this.#cfg
  }

  jobs(): readonly JobSpec[] {
    return [
      {
        name: 'bootstrapEntry',
        // matches cheetah-b1-1's ~10s-after-connect first entry, expressed as a job
        cron: cronAtIstMinute(9 * 60 + 17),
        replayable: false, // places the first order — must not be replayed
        run: async () => this.#enterInitial(),
      },
      {
        name: 'squareOff',
        cron: cronAtIstMinute(this.#cfg.squareOffIstMinute),
        replayable: false,
        // This used to call `#exit('SL')`, described as "EOD flatten, reason
        // irrelevant to the golden diff". It is not irrelevant: `#exit('SL')`
        // falls through to the stop-FLIP branch, which opens a fresh leg on the
        // opposite side at the frozen ATM. So the 15:20 square-off closed one
        // position and immediately took another, which the 15:30 day-end then
        // had to flatten — a brand new intraday position opened ten minutes
        // before the close, every day the strategy was still holding. It now
        // shares the plain flatten with `onDayEnd`, and the two are idempotent
        // against each other because both no-op on a null position.
        run: async () => {
          await this.#flatten()
        },
      },
    ]
  }

  // Async and AWAITED all the way through (unlike cheetah-b1-1.js's own
  // unawaited forEach, F1/F13 in the taxonomy's cross-cutting defects) so
  // that StrategyBase's #guard/drain() genuinely wait for the exit+flip
  // submit calls to land before the next tick is processed.
  protected override async onTick(quote: Quote): Promise<void> {
    const refToken = this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol)
    // C2: the day open must come from the exchange's actual day-open (Kite's `ohlc.open`,
    // cheetah-b1-1.js:115's `bn_quote.ohlc.open`), NEVER from the first tick this strategy
    // happens to observe — the process boots ~09:17 and can miss the real open by any
    // amount, including landing on the exact SAME price as the first tick it sees (which
    // silently forces every entry to PE, since `>` a value equal to itself is false). Block
    // entry (the existing `this.#dayOpen === null` check in #enterInitial) until a real
    // day-open has actually arrived, rather than substituting anything.
    if (this.#dayOpen === null && quote.token === refToken && quote.ohlc !== undefined) {
      this.#dayOpen = quote.ohlc.open
      await this.#persist()
    }
    if (this.#position !== null && quote.token === this.#position.instrument.instrumentToken) {
      const result = logic.evaluateFlipExit(this.#position, quote.lastPrice)
      if (result.exit) await this.#exit(result.reason)
    }
  }

  async #enterInitial(): Promise<void> {
    const refToken = this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol)
    const q = this.ctx.md.quote(refToken)
    if (q === null || this.#dayOpen === null) return
    const side = logic.directionFromOpen(q.lastPrice, this.#dayOpen)
    const atm = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, q.lastPrice)
    this.#frozenAtm = atm
    await this.#openLeg(side, atm)
  }

  /**
   * Close whatever is open, with no flip and no re-entry. The shared body of
   * `onDayEnd` and the `squareOff` job.
   *
   * `reducesExposure: true` is what makes it un-refusable: neither the risk gate
   * nor `StrategyBase`'s stale-feed gate may block an exit, because a feed
   * problem trapping a live position is strictly worse than the feed problem.
   */
  async #flatten(): Promise<void> {
    if (this.#position === null) return
    const closing = this.#position
    this.#position = null // claim-before-await
    const res = await this.submit({
      instrument: closing.instrument, side: 'SELL', lots: closing.quantity, reducesExposure: true,
    })
    if (!res.accepted) {
      // Put it back: a refused flatten leaves a real position open, and a null
      // field here would hide it from the next square-off attempt as well.
      this.#position = closing
    }
    await this.#persist()
  }

  async #openLeg(side: 'CE' | 'PE', atm: number): Promise<void> {
    // M3: cheetah-b1-1.js:127-128 ADDS farOtm for CE but SUBTRACTS it for PE — the strike
    // moves further OTM on both sides, not the same direction on both. Harmless while
    // offsetPoints is 0 (D7), wrong the instant it isn't.
    const strike = side === 'CE' ? atm + this.#cfg.strike.offsetPoints : atm - this.#cfg.strike.offsetPoints
    const inst = this.ctx.md.option(this.#cfg.underlying.symbol, strike, side)
    if (inst === null) return
    const q = this.ctx.md.quote(inst.instrumentToken ?? -1)
    if (q === null) return
    const res = await this.submit({ instrument: inst, side: 'BUY', lots: this.#quantity })
    if (!res.accepted) return
    const levels = logic.computeFlipLevels(q.lastPrice, this.#cfg.trailSlPoints, this.#cfg.targetPoints)
    this.#position = { type: side, entry: q.lastPrice, quantity: this.#quantity, instrument: inst, ...levels }
    this.#quantity = logic.nextMartingaleQty(this.#quantity, this.#cfg.sizing.cap)
    // Position AND the stepped martingale quantity AND the frozen ATM, in one
    // write: they are only meaningful together, and a crash between two writes
    // would leave a live leg with the wrong ladder position behind it.
    await this.#persist()
  }

  async #exit(reason: 'TARGET' | 'SL'): Promise<void> {
    if (this.#position === null) return
    const closing = this.#position
    this.#position = null // claim-before-await
    const res = await this.submit({ instrument: closing.instrument, side: 'SELL', lots: closing.quantity, reducesExposure: true })
    if (!res.accepted) {
      // Refused: the leg is still live, so it must stay visible to the next tick
      // and to the day-end backstop. No flip either — flipping on top of a
      // position that never closed would leave BOTH sides open.
      this.#position = closing
      await this.#persist()
      return
    }

    if (reason === 'TARGET') {
      // Asymmetry is deliberate: TARGET goes idle for the day, no flip, no re-entry.
      this.#idleForDay = true
      await this.#persist()
      return
    }
    // SL: flip to the opposite side at the FROZEN first-tick ATM, re-enter.
    if (this.#idleForDay || this.#frozenAtm === null) {
      await this.#persist()
      return
    }
    const opposite = closing.type === 'CE' ? 'PE' : 'CE'
    // #openLeg persists on success; persist the CLOSE first so a failure to open
    // the flip leg cannot leave the already-closed leg still recorded as open.
    await this.#persist()
    await this.#openLeg(opposite, this.#frozenAtm)
  }
}
