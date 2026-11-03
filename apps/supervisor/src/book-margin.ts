/**
 * WHAT THIS BOOK COSTS TO HOLD, as the engine is allowed to believe it.
 *
 * Two rules read this number and they fail in opposite directions, which is why
 * `MarginInput` carries a provenance and not just a figure:
 *
 *   THE MARGIN TRIM (`guards.ts:marginGuard`) reads `value` at face value and
 *   closes legs when the book is over `margin_cap`. It has to work off whatever
 *   the desk knows, because refusing to trim for want of a fresh figure is how a
 *   book sits over its cap all afternoon.
 *
 *   THE SHIFT'S GATE (`shift.ts:marginArmed`) refuses anything that is not a
 *   FRESH BROKER figure, and the host additionally requires two of them in a row
 *   (`engine-host.ts:#margin`). Phase S spends margin to re-centre; arming it off
 *   a modelled number is authorising a trade with an estimate, which spec §6
 *   forbids in as many words.
 *
 * ── IT READS THE SAME SOURCE desk-api SERVES ────────────────────────────────
 * `desk-book-margin` (`_id = tag`), priced through Zerodha's basket endpoint by
 * desk-marketdata — the only process with a Kite session, because a second login
 * invalidates the first (the 2026-08-04 outage). The rupee figure is
 * `brokerFigures()`, desk-api's own arithmetic: span and exposure at the rates
 * the ACCOUNT is charged (self-calibrated off the XTS snapshot) plus the premium
 * the broker actually blocks. A second copy of that arithmetic here is how the
 * margin tile and the bot's gate come to disagree by five percent with nothing
 * on either to say which is right — the exact defect `book-margin.ts` was
 * extracted to prevent.
 *
 * ── `asOf` MUST ADVANCE PER READ, AND THAT IS WHY THIS IS A POLLER ──────────
 * The host counts CONSECUTIVE fresh broker reads by `asOf`: the same cached
 * figure handed back on ten ticks has been read once, not ten times. So the
 * cache is refreshed on a timer and every tick sees the same snapshot until the
 * next refresh — which is exactly the honest reading. A poller that stamped
 * `asOf: now()` on each call would arm the shift gate off one broker figure
 * counted twice.
 *
 * ── WHY `fresh` IS NOT `ok` ─────────────────────────────────────────────────
 * A document with `ok: false` and a real `asOf` is the DEGRADED case: the last
 * refresh failed and the numbers below it are the last good ones, deliberately
 * left standing so the tile ages rather than blanking. Those are still the
 * broker's numbers and the trim should keep working off them — but they are not
 * something to arm a shift with, so the age decides `fresh` and a failed refresh
 * simply stops advancing `asOf` until one succeeds.
 */

import type { MarginInput } from '@algomaker/desk-engine'
import { brokerCalibration, brokerFigures, type Calibration } from '../../api/src/book-margin.ts'
import { COLLECTIONS, type Database } from '../../api/src/store.ts'
import type { HostLog } from './engine-host.ts'

/**
 * How old a broker figure may be and still arm the shift.
 *
 * Five minutes against desk-marketdata's 30-second sweep: ten consecutive
 * missed refreshes before the gate closes. Deliberately far tighter than the
 * dashboard's 30-minute `BOOK_MARGIN_STALE_MS`, because that threshold decides
 * whether to render an age beside a number and this one decides whether a book
 * may spend margin re-centring.
 */
export const MARGIN_FRESH_MS = 5 * 60_000

/** How often the collection is re-read. desk-marketdata prices every 30 s. */
export const MARGIN_POLL_MS = 30_000

/**
 * The modelled stand-in for a book that has never priced.
 *
 * `value: 0` with `source: 'model'`: the trim reads zero and does nothing (a
 * book of unknown cost is not a book over its cap), and the shift gate refuses
 * it outright because it is not a broker figure. Both are the safe direction,
 * and neither pretends to know anything.
 */
export const NO_MARGIN: MarginInput = { value: 0, source: 'model', asOf: 0, fresh: false }

export interface MarginPollDeps {
  readonly db: Database
  now(): number
  readonly log: HostLog
  /** Override for a test; defaults to `MARGIN_FRESH_MS`. */
  readonly freshMs?: number
}

/**
 * One read of every managed book's margin, cached until the next.
 *
 * Per POLL rather than per book: the calibration is one query for the whole
 * account and the collection is small, so a pass costs two round trips no matter
 * how many books are steered.
 */
export class MarginPoll {
  readonly #d: MarginPollDeps
  readonly #figures = new Map<string, MarginInput>()

  constructor(deps: MarginPollDeps) {
    this.#d = deps
  }

  /** This book's margin as the engine takes it. Never throws. */
  for(tag: string): MarginInput {
    return this.#figures.get(tag) ?? NO_MARGIN
  }

  /**
   * Refresh every book named. Never throws — a margin read that failed must not
   * take the poll timer down, and the previous figure ages on its own `asOf`
   * rather than being replaced by a zero.
   */
  async refresh(tags: ReadonlyArray<string>): Promise<void> {
    if (tags.length === 0) return
    let cal: Calibration | null = null
    try {
      cal = await brokerCalibration(this.#d)
    } catch (err) {
      // Uncalibrated is a documented degraded state (Zerodha's rates rather than
      // the account's), not a reason to have no figure at all.
      this.#d.log.warn('the broker calibration could not be read — margin is uncalibrated', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const freshMs = this.#d.freshMs ?? MARGIN_FRESH_MS
    for (const tag of tags) {
      try {
        const doc = (await this.#d.db
          .collection(COLLECTIONS.bookMargin)
          .findOne({ _id: tag as never })) as Record<string, unknown> | null
        if (doc === null) continue
        const asOf = Number(doc['asOf'] ?? 0)
        // `asOf === 0` means every attempt has failed and the row exists only to
        // carry a diagnostic. That is NOT a figure to render as zero margin.
        if (!Number.isFinite(asOf) || asOf <= 0) continue
        const total = brokerFigures(doc, cal).brokerTotal
        if (!Number.isFinite(total)) continue
        this.#figures.set(tag, {
          value: total,
          source: 'broker',
          asOf,
          fresh: this.#d.now() - asOf <= freshMs,
        })
      } catch (err) {
        this.#d.log.warn('a book margin could not be read — the last figure stands and ages', {
          tag,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** Forget a book we no longer steer, so the map cannot grow with the session. */
  drop(tag: string): void {
    this.#figures.delete(tag)
  }
}
