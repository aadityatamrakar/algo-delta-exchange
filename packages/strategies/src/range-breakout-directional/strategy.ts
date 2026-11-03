import { StrategyBase, cronAtIstMinute, type JobOutcome, type JobSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Interval, Quote, StrategyContext, InstrumentRef } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import { clearSessionState, loadSessionState, saveSessionState } from '../session-state.ts'
import type { RangeBreakoutDirectionalConfig } from './config.ts'

interface DayState {
  bandReady: boolean
  rangeHigh: number
  rangeLow: number
  range: number
  dayBlocked: boolean
  tradedSides: { CE: boolean; PE: boolean }
  entryClosed: boolean
  stopForDay: boolean
  /**
   * `ts` of the newest signal bar an entry check has already judged.
   *
   * Bar time, NOT wall-clock time. The previous field was
   * `lastEntryCheckMinute` — the IST minute of the last check — which made the
   * check fire on the first tick after each minute boundary. A bar only becomes
   * readable when a tick for THAT token crosses the boundary
   * (`CandleStore.#advance`), and the runner routes every declared token to the
   * strategy, so the tick that tripped the check was almost always one of the
   * dozens of option legs rather than the spot. The just-closed spot bar was not
   * in the store yet, and the check re-judged the PREVIOUS bar — putting entries
   * a full 5-minute cycle behind legacy, whose cron deliberately fires at ten
   * seconds past every fifth minute — AFTER each bar closes, never on top of it.
   *
   * Keying on the bar's own `ts` removes the race entirely: each bar is judged
   * exactly once, on whichever tick first makes it readable, and no bar can be
   * judged twice or skipped.
   */
  lastEvaluatedBarTs: number
  /**
   * atr-anchor only: the band forms in two phases, so the WIDTH from phase 1
   * (10:15) has to survive until phase 2 (11:40) anchors the lines on it.
   * `bandReady` stays false in between — there are no lines yet, so there is
   * nothing an entry check could compare a close against.
   */
  atrWidth: number
  atrWidthReady: boolean
}

function freshDay(): DayState {
  return {
    bandReady: false, rangeHigh: 0, rangeLow: 0, range: 0, dayBlocked: false,
    tradedSides: { CE: false, PE: false }, entryClosed: false, stopForDay: false,
    lastEvaluatedBarTs: 0, atrWidth: 0, atrWidthReady: false,
  }
}

/** The option position as it is held in memory — the real instrument included. */
type HeldOption = logic.OptionPosition & {
  readonly instrument: InstrumentRef
  readonly side: 'CE' | 'PE'
  readonly entryPremium: number
}

/**
 * Everything a mid-session restart has to get back, in ONE record.
 *
 * The band/range is here because `formBand` is `replayable: true` and WILL
 * replay on restart — but only `dayBlocked`/`bandReady` stop it re-running, and
 * the atr-anchor path spreads its band across two jobs (10:15 width, 11:40
 * lines) whose second half cannot be recomputed after 11:40 has passed.
 *
 * `tradedSides` is here because without it a restart at 11:00 on a 13:30-deadline
 * config re-opens a side that already traded — on top of the position that is
 * still live. That is the duplicate-position failure this whole record exists to
 * make impossible.
 */
interface PersistedSession {
  readonly day: DayState
  readonly future: logic.FuturePosition | null
  readonly futureEntryTs: number | null
  readonly option: HeldOption | null
  readonly optionEntryTs: number | null
}

/**
 * How much history each phase pulls.
 *
 * Both are deliberately WIDER than the phase strictly consumes, because
 * `candlesClosedBy` then throws away every bar that had not closed at the phase's
 * IST minute. On a mid-session restart the store legitimately holds today's later
 * bars, and a tight `count` would hand back only those — leaving too few to
 * compute anything after the filter. Legacy sizes the same way, asking for 7
 * calendar days of hourly data (atr-band-nifty.js:111) and the whole session of
 * 5-minute data.
 */
// 7 session-anchored hourly bars per NSE day (09:15..15:15); one full day of
// today's bars can be dropped by the filter, so carry a day's worth of slack.
const ATR_WIDTH_EXTRA_BARS = 8
// 09:15-15:30 is 75 five-minute bars — the whole session, same figure the
// opening-range branch below uses.
const SESSION_5MIN_BARS = 75

/**
 * Seconds past `formAtIstMinute` that the opening-range band waits before reading.
 * Legacy's own figure (`orb-scalp.js:292`, `orb-fut.js`): 09:45:**20**, not 09:45:00.
 */
const BAND_FORM_SECOND = 20

/**
 * RangeBreakoutDirectional — 6 modules, 1 class, 3 band sources, 2 execution
 * mappings. See design spec §4.3 "RangeBreakoutDirectional" for the per-module
 * mapping and the invariant that exit.precedence must stay OPPOSITE between
 * the option-buy mapping ([EOD,TARGET,SL]) and the future mapping
 * ([EOD,SL,T1]) — that is config (cfg.exit.precedence), not code here.
 */
export class RangeBreakoutDirectionalStrategy extends StrategyBase {
  readonly #cfg: RangeBreakoutDirectionalConfig
  #day: DayState = freshDay()
  #futurePosition: logic.FuturePosition | null = null
  // C5: the REAL instrument this position entered with, reused verbatim on exit — never
  // fabricated. `instrumentToken` alone (the shipped shape) is not enough to submit a valid
  // exit: the exit path built a synthetic `{tradingsymbol:'CLOSE', lotSize:1, ...}` from it,
  // which is what a broker adapter would actually route on and size by.
  #optionPosition: HeldOption | null = null
  // I1: entry timestamps for the time-stop (timeStopMinutes). Legacy arms a real
  // setTimeout(..., timeStopMin*60000) at entry (bn-breakout.js:213, orb-scalp.js:220,
  // atr-band-nifty.js has none — matches ATR_BAND_NIFTY.timeStopMinutes being read the same
  // way here, at 60). Ports have no ambient timers, so elapsed time is checked on every tick
  // instead — the fix note's explicit suggestion.
  #futureEntryTs: number | null = null
  #optionEntryTs: number | null = null

  constructor(ctx: StrategyContext, cfg: RangeBreakoutDirectionalConfig) {
    super(ctx)
    this.#cfg = cfg
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#day = freshDay()
    this.#futurePosition = null
    this.#futureEntryTs = null
    this.#optionEntryTs = null
    this.#optionPosition = null
  }

  /**
   * Put back everything `onDayStart()` just wiped.
   *
   * `StrategyBase.start()` deliberately runs `onDayStart()` FIRST and this
   * second, so the reset above is the baseline and this is the override — read
   * it as "a fresh day, unless today already happened". It also runs before job
   * catch-up, which is the property that makes the whole thing safe: `formBand`
   * replays into an already-`bandReady` day and returns immediately, and the
   * order-placing `squareOff` is `replayable: false` so catch-up suppresses it
   * and leans on the position recovered here instead.
   */
  protected override async onRecover(): Promise<void> {
    const snap = await loadSessionState<PersistedSession>(this.ctx)
    if (snap === null) return
    // Merged onto a fresh day, not assigned over it: a record written by an
    // earlier build carries that build's DayState shape, and a field this one
    // reads arithmetically (`lastEvaluatedBarTs`) would come back `undefined` and
    // turn every comparison against it into `NaN`.
    this.#day = { ...freshDay(), ...snap.day }
    this.#futurePosition = snap.future
    this.#futureEntryTs = snap.futureEntryTs
    this.#optionPosition = snap.option
    this.#optionEntryTs = snap.optionEntryTs
    this.ctx.log.info(`${this.tag}: recovered session state`, {
      bandReady: snap.day.bandReady,
      rangeHigh: snap.day.rangeHigh,
      rangeLow: snap.day.rangeLow,
      tradedSides: `CE=${snap.day.tradedSides.CE} PE=${snap.day.tradedSides.PE}`,
      future: snap.future === null ? 'none' : `${snap.future.side} ${snap.future.status}`,
      option: snap.option === null ? 'none' : `${snap.option.side} ${snap.option.status} ${snap.option.instrument.tradingsymbol}`,
    })
  }

  /**
   * The backstop every square-off path funnels through: the 15:30 day-end job,
   * the operator switch-off, session rollover and SIGTERM. Before this existed
   * all four were silent no-ops — the only exit that ever ran was the
   * `squareOff` cron, which a process that restarted after its cron time never
   * fires at all.
   *
   * Idempotent by construction: it delegates to the same `#forceExit` the cron
   * uses, and that only acts on an `ACTIVE` position, so the cron running at
   * 15:15 and `stop()` running at 15:30 flatten once between them, not twice.
   * `#forceExit`'s submits carry `reducesExposure: true` so neither the risk
   * gate nor the stale-feed gate can refuse them.
   */
  protected override async onDayEnd(reason: string): Promise<void> {
    const held = this.#futurePosition?.status === 'ACTIVE' || this.#optionPosition?.status === 'ACTIVE'
    if (held) this.ctx.log.info(`${this.tag}: day end (${reason}) — flattening`)
    await this.#forceExit('EOD')

    // The record is dropped ONLY once the book is confirmed flat. A refused exit
    // leaves the position both in memory and on disk, so the next start()
    // recovers it and can try again — an exit that was refused must never read
    // back as a flat book, which is the failure mode where a real position
    // survives the night with nothing managing it.
    // A closed FUTURE stays as a `status: 'CLOSED'` object rather than null (the
    // logic module returns a new position, not null), so "flat" is tested on
    // status, not on the reference.
    if (this.#futurePosition?.status !== 'ACTIVE' && this.#optionPosition?.status !== 'ACTIVE') {
      await clearSessionState(this.ctx)
      return
    }
    this.ctx.log.error(`${this.tag}: day-end flatten did not complete — state kept for recovery`, {
      future: this.#futurePosition === null ? 'none' : this.#futurePosition.status,
      option: this.#optionPosition === null ? 'none' : this.#optionPosition.status,
    })
  }

  /**
   * THE one series this config reads — every band, every signal, every close.
   *
   * It is a method rather than two call sites because band and signal drifting apart
   * is the 2026-08-11 defect in one sentence. `#formBand` preferred
   * `md.future(symbol) ?? spotToken(symbol)` while `#maybeCheckEntry` took `spotToken`
   * for `atm-option-of-side`, so ORB_SCALP_BN drew its opening range on
   * BANKNIFTY26AUGFUT and then tested SPOT closes against it. The band it persisted was
   * byte-identical to ORB_FUT_BN's — 57761.8 / 57401 — and with the basis at ~+62 points
   * the PE line landed at 57343.60 while spot's own 09:15-09:20 close was 57338.60. The
   * index opened below its trigger, so PE was armed before the band existed and fired
   * 300ms after it formed. Legacy read `cfg.spotToken` (orb-scalp.js:109-116).
   *
   * `underlying.reference` is the authority, because that is the field whose two values
   * NAME the two series. It agrees with `executionMapping` on every current config
   * (`index-spot` with `atm-option-of-side`, `current-future` with
   * `signal-instrument-itself`), so routing through here changes nothing for ORB_FUT_*
   * and everything for ORB_SCALP_*.
   *
   * The spot fallback is kept for `current-future`: a config asking for a future it
   * cannot resolve is better off banding and signalling on ONE wrong series than on two
   * different ones, which is the failure this method exists to make unrepresentable.
   */
  #signalToken(): number {
    const symbol = this.#cfg.underlying.symbol
    if (this.#cfg.underlying.reference === 'current-future') {
      return this.ctx.md.future(symbol)?.instrumentToken ?? this.ctx.md.spotToken(symbol)
    }
    return this.ctx.md.spotToken(symbol)
  }

  /**
   * Snapshot the whole session. Called at the point each field changes, never
   * deferred to the end of a tick: a crash between the mutation and the write
   * loses exactly the thing the write exists to protect.
   *
   * The record deliberately survives a flat book for the rest of the session —
   * it still carries `tradedSides` and `stopForDay`, and dropping it the moment
   * the position closes would let a restart at 12:00 re-enter a side that
   * already traded and closed at 11:00.
   */
  async #persist(): Promise<void> {
    await saveSessionState<PersistedSession>(this.ctx, {
      day: this.#day,
      future: this.#futurePosition,
      futureEntryTs: this.#futureEntryTs,
      option: this.#optionPosition,
      optionEntryTs: this.#optionEntryTs,
    })
  }

  /** Anatomy row 20: the base echoes this on start. */
  protected override effectiveConfig(): unknown {
    return this.#cfg
  }

  jobs(): readonly JobSpec[] {
    const band = this.#cfg.band
    // The second band phase exists ONLY for atr-anchor. Every other source forms
    // its band in one step, and handing them a no-op job would put a scheduled
    // name in their logs and their golden `jobsFired` lists that corresponds to
    // nothing they do.
    const anchorJob: readonly JobSpec[] = band.source === 'atr-anchor'
      ? [{
          name: 'anchorBand',
          cron: cronAtIstMinute(band.anchorAtIstMinute),
          replayable: true, // idempotent: only computes the lines, places no order
          run: async () => this.#anchorAtrLines(),
        }]
      : []
    return [
      {
        name: 'formBand',
        // The opening-range band's LAST bar closes at `formAtIstMinute` itself — the
        // 09:40-09:45 bar, at 09:45:00 — and a CandleStore bar closes on the first tick
        // of the next bucket, not on a clock. Firing at :00 is therefore a race against
        // the very bar being read, and on 2026-08-11 BANKNIFTY's future won it while
        // NIFTY's and SENSEX's lost. Legacy set the range at 09:45:20 (orb-scalp.js:292).
        // The retry inside `#formBand` is what makes this correct rather than merely
        // likely; the offset is what stops it needing the retry on an ordinary day.
        // first-candle-pct needs no offset — its 09:15-09:20 bar has been closed for a
        // full minute by the time that band's 09:21 cron fires.
        cron: cronAtIstMinute(
          this.#cfg.band.formAtIstMinute, '1-5',
          this.#cfg.band.source === 'opening-range' ? BAND_FORM_SECOND : 0,
        ),
        replayable: true, // idempotent: only computes a band, places no order
        run: async () => this.#formBand(),
      },
      ...anchorJob,
      {
        name: 'closeEntries',
        cron: cronAtIstMinute(this.#cfg.entryDeadlineIstMinute),
        replayable: true, // idempotent: just flips a flag
        run: async () => {
          this.#day.entryClosed = true
          await this.#persist()
        },
      },
      {
        name: 'squareOff',
        cron: cronAtIstMinute(this.#cfg.squareOffIstMinute),
        replayable: false, // places an exit order — must be re-derived from recovered state
        run: async () => this.#forceExit('EOD'),
      },
    ]
  }

  async #formBand(): Promise<JobOutcome> {
    if (this.#day.bandReady || this.#day.dayBlocked) return
    const band = this.#cfg.band
    if (band.source === 'atr-anchor') return this.#computeAtrWidth()
    if (band.source === 'opening-range') {
      // The SIGNAL's series, never "the future if one happens to resolve" — see
      // `#signalToken`. This line drew ORB_SCALP_BN's band on BANKNIFTY26AUGFUT on
      // 2026-08-11 and the entry check then judged spot closes against it.
      const token = this.#signalToken()
      // Fetch the whole session-so-far, not just band.candleCount — the MarketData
      // port returns the LAST N candles, and the opening range must be the FIRST N
      // candles of the day regardless of when formBand actually fires (catch-up on
      // restart can run this well after 09:15).
      //
      // Then scope to TODAY'S SESSION before windowing. Asking the store for 75 bars
      // at 09:45 returns today's 6 and 69 from previous sessions, so `slice(0, 6)` was
      // taking the oldest six bars in the store — a range from two sessions ago.
      // Legacy never had to think about this because `historyData(today, today)`
      // cannot return another day, NOR a pre-open bar. See `sessionCandlesOn`: on
      // 2026-08-10 the pre-open half of that gap put ORB_SCALP_NIFTY's opening range
      // at 3.8 points and ORB_SCALP_SNX's at 23.8, and both traded on it.
      const raw = await this.ctx.md.candles(token, '5minute', Math.max(band.candleCount, SESSION_5MIN_BARS))
      const today = logic.sessionCandlesOn(raw, '5minute', this.ctx.clock.now())
      const r = logic.computeOpeningRange(today, band.candleCount)
      // NOT ENOUGH BARS IS "COME BACK", NOT "DONE". A bare `void` here is read by the job
      // runner as success, so the band silently never formed again for the rest of the
      // session — on 2026-08-11 that cost ORB_SCALP_NIFTY, ORB_SCALP_SNX, ORB_FUT_NIFTY and
      // ORB_FUT_SNX every trade of the day, with not one line in the log. The last bar of
      // the range closes only when a tick of the NEXT bucket arrives, which is a race this
      // job cannot win outright however late it fires; legacy answered it the same way,
      // re-arming `setTimeout(setupRange, 30000)` while any index was still pending
      // (orb-scalp.js:141) and logging `range candles not ready` on each pass. `JobSpec`
      // leaves `maxRetries` unset deliberately: retry all session, and the log IS the alert.
      if (r === null) {
        this.ctx.log.warn(`${this.tag}: range candles not ready — retrying`, {
          have: today.length,
          need: band.candleCount,
          why: 'the last bar of the opening range closes on the first tick of the next bucket, not on the clock',
        })
        return { retry: true }
      }
      if (!logic.passesRangeFilter(r.range, band.rangeFilterPts)) {
        this.#day.dayBlocked = true
        await this.#persist()
        return
      }
      this.#day.rangeHigh = r.rangeHigh
      this.#day.rangeLow = r.rangeLow
      this.#day.range = r.range
      this.#day.bandReady = true
      // The range window is SPENT: no bar that helped draw the band may be judged as a
      // breakout of it. With one series that is already true by construction — a candle
      // cannot close outside a band its own high and low helped set — and
      // `preopen-bars.test.ts` leans on exactly that. But an invariant worth relying on is
      // worth enforcing: on 2026-08-11 the band came off a DIFFERENT series, the premise
      // quietly failed, and the check 300ms later judged the 09:40 bar and bought a PE.
      // Legacy got this from its schedule — range at 09:45:20, entry crons at `10 *\/5
      // 9-13` — so its first effective judgement was 09:50:10 on the 09:45-09:50 bar.
      this.#day.lastEvaluatedBarTs = Math.max(
        this.#day.lastEvaluatedBarTs,
        today[band.candleCount - 1]?.ts ?? 0,
      )
      await this.#persist()
    } else {
      // The FIRST bar of today's SESSION (09:15-09:20), never the last one in the
      // store and never a pre-open one. `computeLines()` in bn-breakout.js reads
      // `candles[0]` of a today-only fetch, and it reads it the same way on the
      // 09:21 cron and on the mid-session catch-up at line 312. Asking for the last
      // 1 bar happens to agree at 09:21 — when today's first bar IS the newest one —
      // and silently anchors the whole day's band on the 12:55 bar when this
      // replays after a restart.
      const token = this.#signalToken()
      const raw = await this.ctx.md.candles(token, '5minute', SESSION_5MIN_BARS)
      const first = logic.sessionCandlesOn(raw, '5minute', this.ctx.clock.now())[0]
      // Same "come back" as the opening-range branch above and as both atr-anchor
      // phases: legacy re-armed `setTimeout(computeLines, 30000)` when the fetch came
      // back short (bn-breakout.js:118). These two branches were the only ones in this
      // file that forfeited the day instead.
      if (first === undefined) {
        this.ctx.log.warn(`${this.tag}: band candles not ready — retrying`, {
          have: 0,
          need: 1,
          why: 'today\'s first session bar is not in the store yet',
        })
        return { retry: true }
      }
      const { highLine, lowLine } = logic.firstCandleBand(first.close, band.pct)
      this.#day.rangeHigh = highLine
      this.#day.rangeLow = lowLine
      this.#day.bandReady = true
      await this.#persist()
    }
  }

  /**
   * atr-anchor PHASE 1 — 10:15, the band WIDTH only (`computeWidth`,
   * atr-band-nifty.js:107).
   *
   * The defect this replaces: the shipped port did width AND lines here, in one
   * step, off ONE series — it took `atrLines(candles.at(-1).close, width)` on the
   * same 60-minute set the ATR came from. That anchors the day's band on a
   * 60-MINUTE close read at 10:15, when the strategy's rule is a 5-MINUTE close
   * read at 11:40. The two are 85 minutes and a different bar size apart, so the
   * band lands wherever the index happened to be at 10:15. In the golden day that
   * is a 100-point error, which pulls `lowLine` up above a perfectly ordinary
   * later close and turns it into a "stop" the legacy launcher never sees.
   *
   * Spot, not the future: `atr-band-nifty.js` reads `spotToken` (256265) for
   * every one of its series, and this config says `reference: 'index-spot'`. It
   * also has to be the SAME series the exit check compares against — mixing a
   * futures-derived band with a spot-derived close is a smaller version of the
   * scale bug fixed in `#checkOptionExit`.
   */
  async #computeAtrWidth(): Promise<JobOutcome> {
    const band = this.#cfg.band
    if (band.source !== 'atr-anchor' || this.#day.atrWidthReady) return
    const token = this.ctx.md.spotToken(this.#cfg.underlying.symbol)
    const raw = await this.ctx.md.candles(token, band.widthInterval, band.atrPeriod + ATR_WIDTH_EXTRA_BARS)
    const closed = logic.candlesClosedBy(raw, band.widthInterval, band.formAtIstMinute, this.ctx.clock.now())
    const atr = logic.wilderAtr(closed, band.atrPeriod)
    // Legacy's own line: "not enough hourly candles for ATR, retrying in 30s".
    // Returning plain `void` here would silently forfeit the whole day the first
    // time a history fetch is late.
    if (atr === null) return { retry: true }
    this.#day.atrWidth = logic.atrBandWidth(atr, band.divisor)
    this.#day.atrWidthReady = true
    // The width is a PHASE-1 artefact: a restart between 10:15 and 11:40 cannot
    // recompute it from `anchorBand` alone, and `#anchorAtrLines` would sit on
    // `{ retry: true }` all session waiting for a width that never comes back.
    await this.#persist()
    this.ctx.log.info(`${this.tag}: ATR width set`, { atr, width: this.#day.atrWidth })
    return
  }

  /**
   * atr-anchor PHASE 2 — 11:40, the band LINES (`computeLines`,
   * atr-band-nifty.js:135): the 11:35-11:40 5-MINUTE close +/- the width frozen
   * at 10:15. `bandReady` flips only here, because until the lines exist there is
   * nothing for an entry check to compare a close against.
   */
  async #anchorAtrLines(): Promise<JobOutcome> {
    const band = this.#cfg.band
    if (band.source !== 'atr-anchor' || this.#day.bandReady || this.#day.dayBlocked) return
    // Legacy: "width not ready at 11:40, retrying lines in 30s". The phases are
    // ordered, so phase 2 waits rather than anchoring on a width of 0.
    if (!this.#day.atrWidthReady) return { retry: true }
    const token = this.ctx.md.spotToken(this.#cfg.underlying.symbol)
    const raw = await this.ctx.md.candles(token, band.anchorInterval, SESSION_5MIN_BARS)
    const closed = logic.candlesClosedBy(raw, band.anchorInterval, band.anchorAtIstMinute, this.ctx.clock.now())
    const anchor = closed[closed.length - 1]
    if (anchor === undefined) return { retry: true }
    const { highLine, lowLine } = logic.atrLines(anchor.close, this.#day.atrWidth)
    this.#day.rangeHigh = highLine
    this.#day.rangeLow = lowLine
    this.#day.bandReady = true
    await this.#persist()
    this.ctx.log.info(`${this.tag}: ATR band lines set`, {
      anchorClose: anchor.close, highLine, lowLine, width: this.#day.atrWidth,
    })
    return
  }

  protected override async onTick(quote: Quote): Promise<void> {
    // I1: the time stop is checked FIRST, on every tick — legacy's setTimeout fires
    // independent of any tick, so a port relying only on tick-driven price checks needs
    // SOME tick to arrive after the deadline to notice it (see #checkTimeStops). Checking it
    // before dispatching to the regular exit/entry paths means a position that has just timed
    // out is never ALSO evaluated by the price-based exit logic in the same tick.
    await this.#checkTimeStops()
    if (this.#futurePosition?.status === 'ACTIVE') { await this.#checkFutureExit(quote); return }
    if (this.#optionPosition?.status === 'ACTIVE') { await this.#checkOptionExit(quote); return }
    await this.#maybeCheckEntry()
  }

  /** I1: force-exit any position whose timeStopMinutes has elapsed since entry. */
  async #checkTimeStops(): Promise<void> {
    if (this.#cfg.timeStopMinutes === undefined) return
    const elapsedMs = this.#cfg.timeStopMinutes * 60_000
    const nowMs = this.ctx.clock.now()
    if (this.#futurePosition?.status === 'ACTIVE' && this.#futureEntryTs !== null
      && nowMs - this.#futureEntryTs >= elapsedMs) {
      const result = logic.evaluateFutureExit(this.#futurePosition, 0, { forceExit: true })
      if (await this.#submitFutureActions(result.actions)) {
        this.#futurePosition = result.position
        this.#futureEntryTs = null
        await this.#persist()
      }
    }
    if (this.#optionPosition?.status === 'ACTIVE' && this.#optionEntryTs !== null
      && nowMs - this.#optionEntryTs >= elapsedMs) {
      await this.#closeOption()
    }
  }

  async #maybeCheckEntry(): Promise<void> {
    if (!this.#day.bandReady || this.#day.dayBlocked || this.#day.entryClosed || this.#day.stopForDay) return

    // The SAME resolver every band uses, so the band and the close it is compared
    // against can never come from two different instruments again. `reference` and
    // `executionMapping` agree on every current config, so this is the selector that
    // was already here, with the pairing made structural instead of coincidental.
    const token = this.#signalToken()
    // The series the SIGNAL is read from. atr-anchor's rule is "2 consecutive
    // `anchorInterval` closes beyond the line", so that is the series whose bars
    // pace its checks; every other source signals off the 5-minute bar.
    const signalInterval: Interval = this.#cfg.band.source === 'atr-anchor' ? this.#cfg.band.anchorInterval : '5minute'
    const candles = await this.ctx.md.candles(token, signalInterval, 1)
    const c = candles[0]
    if (c === undefined) return
    // One judgement per bar, paced in BAR time. `entryCheckEveryMinutes` is a
    // minimum spacing between judged bars, not a wall-clock throttle — on every
    // current config it is exactly the bar size, so consecutive bars pass it and
    // the cadence matches legacy's every-5-minutes cron.
    if (c.ts - this.#day.lastEvaluatedBarTs < this.#cfg.entryCheckEveryMinutes * 60_000) return
    this.#day.lastEvaluatedBarTs = c.ts
    await this.#persist()

    // M1: cfg.band.bufferPct, not a hardcoded 0.001 — only the 'opening-range' band source
    // carries this field, and every call site below that reads it is only ever reached with
    // that band source (the other two sources take an earlier return/branch), so the
    // narrowing check is defensive, not load-bearing. Every current config happens to set
    // 0.001 too, which is exactly why this was latent rather than already-broken.
    const bufferPct = this.#cfg.band.source === 'opening-range' ? this.#cfg.band.bufferPct : 0.001

    if (this.#cfg.band.source === 'atr-anchor') {
      // Same series the lines were anchored on — the entry rule is "2 consecutive
      // UNDERLYING candles closing beyond the line", so signal and band must share
      // both the instrument and the bar size.
      const last2 = await this.ctx.md.candles(token, this.#cfg.band.anchorInterval, 2)
      const side = logic.atrEntrySignal([...last2], this.#day.rangeHigh, this.#day.rangeLow)
      // `!tradedSides[side]` is the port of atr-band-nifty.js's `ceUsed`/`peUsed`
      // (`:205`, `:208`, and again defensively in `enterPosition` at `:219`): ONE
      // entry per side per day. This branch was the only one of the three missing
      // the guard its siblings below both have, and ATR_BAND_NIFTY's
      // `stopDayOnNonLoss: false` means `#closeOption()` never sets `stopForDay`
      // either — so nothing at all stopped the same side re-entering every 5
      // minutes for the rest of the session.
      if (side !== null && !this.#day.tradedSides[side]) await this.#enterOption(side)
      return
    }
    if (this.#cfg.executionMapping === 'signal-instrument-itself') {
      const side = logic.breakoutSideFromRange(c.close, this.#day.rangeHigh, this.#day.rangeLow, bufferPct)
      if (side !== null) await this.#enterFuture(side)
      return
    }
    // atm-option-of-side, opening-range or first-candle-pct
    if (this.#cfg.band.source === 'first-candle-pct') {
      const side = logic.firstCandleBreakoutSide(c, this.#day.rangeHigh, this.#day.rangeLow)
      if (side !== null && !this.#day.tradedSides[side]) await this.#enterOption(side)
      return
    }
    // C4: breakoutSideFromRange returns null for "no signal" — legacy's orb-scalp-logic.js
    // treats that as NO TRADE. Coercing it into 'SELL' before mapping to a side (as the
    // shipped code did with `?? 'SELL'`) manufactures a phantom PE entry on every day with no
    // breakout at all, on a mapping used by 3 live configs. `raw === null` must short-circuit
    // BEFORE sideFromSignal ever runs.
    const raw = logic.breakoutSideFromRange(c.close, this.#day.rangeHigh, this.#day.rangeLow, bufferPct)
    if (raw === null) return
    const side = logic.sideFromSignal(raw)
    if (!this.#day.tradedSides[side]) await this.#enterOption(side)
  }

  async #enterFuture(side: 'BUY' | 'SELL'): Promise<void> {
    const inst = this.ctx.md.future(this.#cfg.underlying.symbol)
    if (inst === null) return
    const q = this.ctx.md.quote(inst.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol))
    if (q === null) return
    const lots = this.#cfg.sizing.kind === 'flat' ? this.#cfg.sizing.lots : 1
    const res = await this.submit({ instrument: inst, side, lots })
    if (!res.accepted) return
    this.#futurePosition = logic.openFuturePosition(side, q.lastPrice, this.#day.range, this.#day.rangeHigh, this.#day.rangeLow, lots)
    this.#futureEntryTs = this.ctx.clock.now()
    // One trade per day, burned at ENTRY — `orb-fut-core.js:159` sets `tradedToday`
    // the moment the order is placed and never resets it, and `checkBreakout()`
    // tests it on every later 5-minute check. Nothing on the FUTURE path used to
    // set this: `stopForDay` was only ever set in `#closeOption()`, so once an SL
    // or T1 closed the position, the next tick fell straight through to
    // `#maybeCheckEntry()` and re-entered on the same breakout — all the way to
    // the 14:00 deadline.
    if (this.#cfg.dayBudget.kind === 'per-day') this.#day.stopForDay = true
    // Written the instant the position exists. A crash one tick later must find
    // this on disk, or the restart's `onDayStart()` nulls it and nothing —
    // neither the tick exits, nor the time stop, nor the day-end flatten — can
    // ever close it again.
    await this.#persist()
  }

  /** M4: look up the future instrument ONCE and bail if it's gone, rather than casting a
   *  possibly-null lookup `as never` and submitting `instrument: null` to the gateway.
   *
   *  Returns whether the exit actually LANDED. The caller must not mark the
   *  position CLOSED off a refused or unroutable order: a position marked closed
   *  while it is still open at the broker is invisible to every subsequent exit
   *  path, including the day-end backstop. */
  async #submitFutureActions(actions: readonly logic.FutureExitAction[]): Promise<boolean> {
    if (actions.length === 0) return true
    const inst = this.ctx.md.future(this.#cfg.underlying.symbol)
    if (inst === null) return false
    let allAccepted = true
    for (const a of actions) {
      const res = await this.submit({ instrument: inst, side: a.side, lots: a.lots, reducesExposure: true })
      if (!res.accepted) allAccepted = false
    }
    return allAccepted
  }

  async #checkFutureExit(quote: Quote): Promise<void> {
    if (this.#futurePosition === null) return
    const result = logic.evaluateFutureExit(this.#futurePosition, quote.lastPrice)
    if (!(await this.#submitFutureActions(result.actions))) return
    this.#futurePosition = result.position
    if (result.position.status !== 'ACTIVE') this.#futureEntryTs = null
    await this.#persist()
  }

  async #forceExit(_reason: 'EOD'): Promise<void> {
    if (this.#futurePosition?.status === 'ACTIVE') {
      const result = logic.evaluateFutureExit(this.#futurePosition, 0, { forceExit: true })
      if (await this.#submitFutureActions(result.actions)) {
        this.#futurePosition = result.position
        this.#futureEntryTs = null
        await this.#persist()
      }
    }
    if (this.#optionPosition?.status === 'ACTIVE') {
      const r = logic.evaluateOptionExit(this.#optionPosition, undefined, undefined, { forceExit: true })
      if (r.exit) await this.#closeOption()
    }
  }

  async #enterOption(side: 'CE' | 'PE'): Promise<void> {
    const spotLtp = this.ctx.md.quote(this.ctx.md.spotToken(this.#cfg.underlying.symbol))?.lastPrice
    if (spotLtp === undefined) return
    const strike = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, spotLtp)
    const inst = this.ctx.md.option(this.#cfg.underlying.symbol, strike + this.#cfg.strike.offsetPoints, side)
    if (inst === null) return
    const optQ = this.ctx.md.quote(inst.instrumentToken ?? -1)
    if (optQ === null) return
    const lots = this.#cfg.sizing.kind === 'flat' ? this.#cfg.sizing.lots : 1
    const res = await this.submit({ instrument: inst, side: 'BUY', lots })
    if (!res.accepted) return
    this.#day.tradedSides[side] = true
    // Burned at ENTRY, matching `orb-scalp.js:210`'s `tradedToday`. `#closeOption()`
    // sets it again on the way out; this is the earlier, unconditional half, so a
    // cleared-then-restored position can never buy a second entry.
    if (this.#cfg.dayBudget.kind === 'per-day') this.#day.stopForDay = true
    const target = this.#cfg.band.source === 'atr-anchor'
      ? logic.atrTarget(optQ.lastPrice, 20, 0.3)
      : optQ.lastPrice + (this.#cfg.exit.target.basis === 'fixed-points' ? this.#cfg.exit.target.value : 0)
    this.#optionPosition = {
      side, status: 'ACTIVE', target, slSpot: logic.spotSl(side, this.#day.rangeHigh, this.#day.rangeLow),
      instrument: inst, entryPremium: optQ.lastPrice,
    }
    this.#optionEntryTs = this.ctx.clock.now()
    // ONE write covering both the position and the `tradedSides` flag it just
    // burned. Two writes would have an ordering hazard either way round: flag
    // first loses the position on a crash between them, position first lets the
    // same side trade twice once it closes.
    await this.#persist()
  }

  async #checkOptionExit(quote: Quote): Promise<void> {
    if (this.#optionPosition === null) return
    const spotLtp = this.ctx.md.quote(this.ctx.md.spotToken(this.#cfg.underlying.symbol))?.lastPrice
    const optLtp = quote.token === this.#optionPosition.instrument.instrumentToken ? quote.lastPrice : undefined
    if (this.#cfg.band.source === 'atr-anchor') {
      // The stop is a candle-close test against the BAND, and the band is drawn on
      // the UNDERLYING (atr-band-nifty.js:188 fetches `spotToken`, not the option).
      // The shipped port read the OPTION's own token here, so `atrStopHitOnClose`
      // compared a ~100-rupee premium against a ~22,300 spot-scale `lowLine`: for a
      // CE that is `100 < 22293` — true on the very first check after entry, every
      // time, so every CE was force-closed within a candle of being opened on a
      // stop that had not happened. A PE is the mirror (`premium > highLine` is
      // never true), so that side silently lost its stop altogether. Neither shows
      // up in atr-band-logic.js's unit tests, which are only ever handed
      // correctly-scoped closes.
      const underlyingToken = this.ctx.md.spotToken(this.#cfg.underlying.symbol)
      const closes = await this.ctx.md.candles(underlyingToken, this.#cfg.band.anchorInterval, 1)
      const last = closes[0]
      if (last !== undefined && logic.atrStopHitOnClose(this.#optionPosition.side, last.close, this.#day.rangeHigh, this.#day.rangeLow)) {
        await this.#closeOption()
        return
      }
      if (optLtp !== undefined && optLtp >= this.#optionPosition.target) await this.#closeOption()
      return
    }
    const r = logic.evaluateOptionExit(this.#optionPosition, optLtp, spotLtp)
    if (r.exit) await this.#closeOption()
  }

  async #closeOption(): Promise<void> {
    if (this.#optionPosition === null) return
    const closing = this.#optionPosition
    const entryTs = this.#optionEntryTs
    this.#optionPosition = null // claim-before-await
    this.#optionEntryTs = null
    const exitQ = this.ctx.md.quote(closing.instrument.instrumentToken ?? -1)
    const exitPrice = exitQ?.lastPrice ?? closing.entryPremium
    const lots = this.#cfg.sizing.kind === 'flat' ? this.#cfg.sizing.lots : 1
    // C5: reuse the REAL instrument stored at entry — never fabricate one. `tradingsymbol` is
    // what a broker adapter routes an order on, and a fabricated `lotSize:1` corrupts any
    // `lotSize * lots` quantity computation downstream.
    const res = await this.submit({
      instrument: closing.instrument,
      side: 'SELL', lots, reducesExposure: true,
    })

    // A REFUSED exit puts the position back. The claim-before-await above is a
    // re-entrancy guard, not a decision that the leg is gone — and leaving it
    // cleared after a rejection is how a live option ends up with no exit path
    // at all: `onTick` only checks a non-null `#optionPosition`, and the day-end
    // backstop reads the same field. Restoring it means the next tick (and the
    // 15:30 flatten) tries again, and the persisted record keeps saying "open".
    if (!res.accepted) {
      this.#optionPosition = closing
      this.#optionEntryTs = entryTs
      await this.#persist()
      return
    }

    if (this.#cfg.dayBudget.kind === 'per-day') {
      this.#day.stopForDay = true
      await this.#persist()
      return
    }
    // 'per-side': a profitable-or-breakeven trade ends the day; a loss leaves
    // the opposite side tradeable, UNLESS it was already used too — ported
    // verbatim from bn-breakout-logic.js's dayContinuesAfterExit (Task 2 Step 1).
    const pnl = exitPrice - closing.entryPremium // long option: BUY entry, SELL exit
    const otherSide = closing.side === 'CE' ? 'PE' : 'CE'
    const continues = this.#cfg.dayBudget.stopDayOnNonLoss
      ? logic.dayContinuesAfterExit(pnl, this.#day.tradedSides[otherSide])
      : true // when the config does NOT gate on a non-loss, a loss always leaves the other side open
    this.#day.stopForDay = !continues
    await this.#persist()
  }
}
