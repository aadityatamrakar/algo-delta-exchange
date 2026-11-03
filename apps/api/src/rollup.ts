/**
 * The arithmetic behind every P&L number this app reports: the live card, the
 * 15s snapshot, and the day-end rollup.
 *
 * PURE, and deliberately so. The rollup written at 15:40 and the rollup
 * recomputed from fills three days later when someone notices the process was
 * down must be the SAME number, and the only way to be sure of that is for both
 * to call the same function with no clock, no Mongo and no marks cache in it.
 * Everything IO-shaped lives in `pnlstore.ts` and `pnl-jobs.ts`.
 *
 * The arithmetic itself is NOT here — it is `@algomaker/pnl`, which owns
 * average cost, the short-open credit and the mark. This module only decides
 * WHICH fills go in, how the window is cut, and what an incomplete answer looks
 * like on the wire.
 *
 * THE WINDOW, which is the one genuinely non-obvious decision:
 *
 *   These books carry. A short strangle sold on Monday is still open on Friday,
 *   part-covered on Wednesday and rolled on Thursday. So "today's fills" alone
 *   cannot price the book: a buy-back today of a leg sold last week would look
 *   like OPENING a long at the buy-back price, and both the realised figure and
 *   the open position would be wrong.
 *
 *   Positions are therefore built from every fill in the lookback window
 *   (`carried` + `during`), while REALISED is reported only for `during` —
 *   the difference between the cumulative realised at the end of the window and
 *   at its start. That is exactly what a broker shows: today's booked P&L, plus
 *   the open position marked against its own average cost.
 */

import { FNO_CLOSE_MIN } from '@algomaker/core'
import {
  buildPositions,
  totalCosts,
  unrealised as markOpenLegs,
  type Costs,
  type Marks,
  type PnlFill,
  type Position,
} from '@algomaker/pnl'
import { IST_OFFSET_MS } from './routes/kit.ts'
import { API_VENUE, isNse, type VenueSpec } from './venue.ts'

/** A fill with the timestamp we file it under. See `pnlstore.loadFills`. */
export interface StampedFill extends PnlFill {
  readonly ts: number
  /**
   * What the fill DID, when the stored document recorded it.
   *
   * Carried purely so a consumer can tell an OPEN from a CLOSE. Rebuilding a
   * position from a window that starts after the opens but before the closes
   * nets to a position that was never held — and acting on that sends an order
   * in the WRONG DIRECTION, which for a flatten means opening fresh exposure
   * rather than removing it. Without `op` there is nothing in the reconstructed
   * data that could ever reveal the truncation.
   *
   * Optional because a hand-repaired or pre-existing document may not have one;
   * absent means "unknown", never "open".
   */
  readonly op?: 'open' | 'close' | 'roll' | 'resize'
  /**
   * WHAT THE VENUE CHARGED FOR THIS FILL, in the book currency (Delta: USD,
   * GST included). Absent is zero — every NSE fill, whose charges the desk
   * reports gross (B3). Charged against realised in the window the fill lands
   * in, never spread over a mark.
   */
  readonly fee?: number
}

/** A fill's fee, or 0. A non-finite or negative value is not a charge. */
export function feeOf(f: { readonly fee?: number }): number {
  const v = f.fee
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * Fills split at the window boundary.
 *
 * `carried` is not decoration: it is what makes the average cost of an
 * overnight position right, and without it a buy-back realises against nothing.
 */
export interface PnlWindow {
  readonly carried: readonly StampedFill[]
  readonly during: readonly StampedFill[]
}

/**
 * One strategy's P&L, in the shape the API contract §3 fixes.
 *
 * `unrealised` and `total` are `null` — never 0 — when any open leg could not
 * be marked, with the offending contracts named in `unpriced`. A P&L of ₹0 and
 * a P&L of "three legs could not be marked" render identically otherwise, which
 * is the defect already fixed once in the positions endpoint (Phase B §8).
 * `realised` stays a number in that case: it is booked, and no mark can change
 * it.
 */
export interface StrategyPnl {
  /** Booked in the window, NET of `fees` and of any supplied costs. */
  readonly realised: number
  /** Booked in the window before fees and costs. */
  readonly gross: number
  /** Venue fees on the window's own fills. 0 when no fill carries one. */
  readonly fees: number
  readonly unrealised: number | null
  readonly total: number | null
  readonly openLegs: number
  readonly unpriced: readonly string[]
  readonly complete: boolean
  /** Positions as of the end of the window, carried legs included. */
  readonly positions: readonly Position[]
  /**
   * The OPEN legs only, marked — what a positions table renders.
   *
   * Derived here rather than by the caller because it is the same set
   * `openLegs` counts, and the 2026-07-28 defect is what happens when the two
   * come from different places: the dashboard read `desk-books` for its
   * positions, hosted strategies never write one, and every hosted tag rendered
   * "no open legs" beside a P&L that had just counted six of them.
   */
  readonly legs: readonly MarkedLeg[]
}

/**
 * One contract the strategy traded in the window, priced.
 *
 * `mark` and `unrealised` are `null` — never 0 — for a leg the feed could not
 * price, for the same reason `StrategyPnl.unrealised` is: the leg is real and
 * carrying risk, and dropping it (or showing it at zero) makes the book render
 * smaller than it is, which on a positions table is the calmest-looking
 * dangerous state there is. They are also null for a CLOSED contract, where
 * there is genuinely nothing to mark.
 */
export interface MarkedLeg {
  readonly tradingsymbol: string
  /** SIGNED contract qty: negative is short. ZERO means a closed round trip. */
  readonly qty: number
  readonly avgCost: number
  /** Last traded price. `null` when the feed could not price it. */
  readonly mark: number | null
  readonly unrealised: number | null
  /**
   * Booked on this contract INSIDE THE WINDOW, gross of costs — the prior
   * lookback's realised is subtracted the same way the card's total subtracts
   * `carriedRealised`, so summing these legs reproduces the card rather than
   * a figure inflated by every earlier day still inside the lookback.
   */
  readonly realised: number
  /** The venue fees on this contract's window fills, already taken off `realised`. */
  readonly fees: number
  /**
   * The two sides of what was actually traded, over the SAME fills the
   * position was built from.
   *
   * `qty === buyQty - sellQty` always holds, which is the point: a position
   * book whose net does not reconcile against its own two sides cannot be
   * checked by eye, and this is the table an operator uses to confirm a
   * strategy did what they think it did. Values are the CASH traded
   * (sum of price x qty), not an average — an average is recoverable by
   * dividing, the total is not recoverable from an average.
   */
  readonly buyQty: number
  readonly buyValue: number
  readonly sellQty: number
  readonly sellValue: number
  /**
   * Mark to market for this contract: realised plus whatever is still open.
   *
   * `null` — never 0 — when the contract is still open and could not be
   * marked, for the same reason `unrealised` is. A closed contract is always a
   * number: its MTM is exactly what it booked, and nothing can change it.
   */
  readonly mtm: number | null
}

/**
 * Cut a fill list at `boundaryMs`. Fills at exactly the boundary are INSIDE the
 * window: an IST day starts at 00:00:00.000 and a fill stamped there belongs to
 * that day, not the previous one.
 *
 * The input is assumed already ordered — average cost is path-dependent, so the
 * caller's order is authoritative and this never re-sorts (see `PnlFill.ts`).
 */
export function splitFills(fills: readonly StampedFill[], boundaryMs: number): PnlWindow {
  const carried: StampedFill[] = []
  const during: StampedFill[] = []
  for (const f of fills) {
    if (f.ts < boundaryMs) carried.push(f)
    else during.push(f)
  }
  return { carried, during }
}

/**
 * The whole computation, for one strategy in one mode.
 *
 * Costs (B3) are subtracted from the WINDOW's realised, once. They default to
 * zero and the reported basis is gross: the Python desk owns its own net via
 * its `CostModel`, and a second cost model applied silently here would make our
 * number and theirs disagree for reasons neither side could explain.
 */
export function computeWindowPnl(w: PnlWindow, marks: Marks, costs?: Costs): StrategyPnl {
  const positions = buildPositions([...w.carried, ...w.during])
  const carriedPositions = buildPositions(w.carried)

  let cumulative = 0
  for (const p of positions) cumulative += p.realised
  let carriedRealised = 0
  for (const p of carriedPositions) carriedRealised += p.realised

  // Booked by the fills INSIDE the window. Everything before it was already
  // reported on the day it happened; counting it again would make a week-old
  // roll reappear in today's number every day until the position closed.
  const gross = cumulative - carriedRealised
  const feesBySymbol = new Map<string, number>()
  let fees = 0
  for (const f of w.during) {
    const fee = feeOf(f)
    if (fee === 0) continue
    fees += fee
    feesBySymbol.set(f.tradingsymbol, (feesBySymbol.get(f.tradingsymbol) ?? 0) + fee)
  }
  const realised = gross - fees - totalCosts(costs)

  const open = markOpenLegs(positions, marks)
  const complete = open.unpriced.length === 0
  const unrealised = complete ? open.total : null

  // Marked legs by contract, so an unpriced leg below can still be emitted with
  // everything EXCEPT its mark rather than being skipped.
  const marked = new Map(open.legs.map((l) => [l.tradingsymbol, l]))
  /**
   * EVERY contract the window touched, CLOSED ONES INCLUDED (qty 0).
   *
   * A round trip that opened and closed intraday is the most common thing a
   * scalping strategy does, and dropping it left the table saying "no open
   * legs" for a tag that had traded all morning and booked real money — the
   * work was invisible and the realised figure on the card above had nothing
   * behind it. A flat row states its own status: qty 0, no mark, no
   * unrealised, and the realised P&L it actually booked.
   *
   * `openLegs` still counts only qty != 0 — it feeds the snapshot's
   * idle-strategy filter and the rollup's `closingPositions`, both of which
   * mean OPEN, so it must not start counting closed round trips.
   */
  const traded = tradedBySymbol([...w.carried, ...w.during])
  /**
   * THE SAME SUBTRACTION THE CARD MAKES, PER CONTRACT.
   *
   * `positions` is netted over `carried + during` — the whole lookback, 30 days
   * by default — so `p.realised` is CUMULATIVE, while the card's `realised`
   * above subtracts `carriedRealised` and reports only this window. Both feed
   * the same page: the strategy view sums these legs into its Total row and the
   * Positions pill shows the card. So a book that CARRIES — the normal state
   * for a short-premium desk, not an edge case — showed two different totals
   * for one tag on two screens, the table's inflated by every prior day still
   * inside the lookback.
   */
  const carriedRealisedBySymbol = new Map(carriedPositions.map((p) => [p.tradingsymbol, p.realised]))
  /**
   * Contracts with a fill INSIDE the window. A qty-0 contract is only today's
   * work if it traded today; one closed on a previous day is history that was
   * reported when it happened, and it was reappearing in "Net positions" at qty
   * 0 — re-marked with today's LTP — every day until the lookback rolled off.
   */
  const tradedInWindow = tradedBySymbol(w.during)
  const legs: MarkedLeg[] = positions.flatMap((p) => {
    if (p.qty === 0 && !tradedInWindow.has(p.tradingsymbol)) return []
    const m = marked.get(p.tradingsymbol)
    /**
     * A CLOSED contract still gets its LTP.
     *
     * `markOpenLegs` skips qty-0 positions — correctly, since a flat leg has no
     * exposure and a missing quote for it is not a gap in the P&L. But the
     * dashboard wants the price anyway: after a round trip the question "where
     * is it trading now?" is how you judge whether the exit was early or late,
     * and an em-dash answers nothing. So the mark is read from the resolver
     * directly here rather than borrowed from the unrealised pass.
     *
     * `unrealised` stays null regardless. There is no open quantity for a price
     * to be unrealised against, and a number there would imply exposure that
     * was closed hours ago.
     */
    const direct = marks[p.tradingsymbol]
    const mark = m?.mark
      ?? (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0 ? direct : null)
    const unreal = p.qty === 0 ? null : (m?.unrealised ?? null)
    const t = traded.get(p.tradingsymbol)
    // Booked by THIS window's fills on this contract, matching the card.
    // Net of this contract's own fees, so the legs still sum to the card.
    const legFees = feesBySymbol.get(p.tradingsymbol) ?? 0
    const bookedHere = p.realised - (carriedRealisedBySymbol.get(p.tradingsymbol) ?? 0) - legFees
    return [{
      tradingsymbol: p.tradingsymbol,
      qty: p.qty,
      avgCost: p.avgCost,
      mark,
      unrealised: unreal,
      realised: bookedHere,
      fees: legFees,
      buyQty: t?.buyQty ?? 0,
      buyValue: t?.buyValue ?? 0,
      sellQty: t?.sellQty ?? 0,
      sellValue: t?.sellValue ?? 0,
      // Closed: MTM is exactly what it booked. Open and marked: booked plus
      // open. Open and unmarked: UNKNOWN, and saying 0 would read as flat.
      mtm: p.qty === 0 ? bookedHere : unreal === null ? null : bookedHere + unreal,
    }]
  })

  return {
    realised,
    gross,
    fees,
    unrealised,
    total: unrealised === null ? null : realised + unrealised,
    openLegs: positions.filter((p) => p.qty !== 0).length,
    unpriced: open.unpriced,
    complete,
    positions,
    legs,
  }
}

/**
 * Buy and sell totals per contract, over the fills a position was built from.
 *
 * Built from the SAME array `buildPositions` consumes, so `qty === buyQty -
 * sellQty` holds for every row. Reading a different set — today's fills only,
 * say — would break that identity for anything carried overnight, and a
 * position book whose net does not reconcile against its own two sides is one
 * an operator cannot check by eye.
 */
function tradedBySymbol(fills: readonly StampedFill[]): Map<string, {
  buyQty: number
  buyValue: number
  sellQty: number
  sellValue: number
}> {
  const out = new Map<string, { buyQty: number; buyValue: number; sellQty: number; sellValue: number }>()
  for (const f of fills) {
    let acc = out.get(f.tradingsymbol)
    if (acc === undefined) {
      acc = { buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0 }
      out.set(f.tradingsymbol, acc)
    }
    // `qty` is always positive; the side is what signs it (see `PnlFill`).
    if (f.side === 'Buy') {
      acc.buyQty += f.qty
      acc.buyValue += f.qty * f.price
    } else {
      acc.sellQty += f.qty
      acc.sellValue += f.qty * f.price
    }
  }
  return out
}

/** Every contract the window touched. What to ask the mark cache for. */
export function symbolsIn(w: PnlWindow): string[] {
  const seen = new Set<string>()
  for (const f of w.carried) seen.add(f.tradingsymbol)
  for (const f of w.during) seen.add(f.tradingsymbol)
  return [...seen]
}

// ------------------------------------------------------------------ extremes

/** One point of the persisted intraday series. */
export interface SeriesPoint {
  readonly ts: number
  readonly realised: number
  readonly unrealised: number | null
  readonly total: number | null
}

export interface Extremes {
  readonly maxProfit: number | null
  readonly maxLoss: number | null
  /** Points that actually carried a number. Zero means both are null. */
  readonly used: number
}

/**
 * The day's best and worst marked-to-market points, from the snapshot series.
 *
 * Points whose `total` is null are SKIPPED, not read as zero — a stretch where
 * the feed was down would otherwise plant a fake ₹0 low in the middle of a
 * profitable day and make `maxLoss` a number nobody can explain.
 *
 * Both are null when no point carried a total. "We do not know the intraday
 * extremes" is not "the extremes were zero", and a rollup written after a
 * snapshot outage has to be able to say the former.
 *
 * `maxLoss` is the minimum of the series, which on a day that never went
 * negative is a POSITIVE number: it is the worst the day got, not a loss that
 * has to exist.
 */
export function extremes(points: readonly SeriesPoint[]): Extremes {
  let maxProfit: number | null = null
  let maxLoss: number | null = null
  let used = 0
  for (const p of points) {
    if (p.total === null || !Number.isFinite(p.total)) continue
    used++
    if (maxProfit === null || p.total > maxProfit) maxProfit = p.total
    if (maxLoss === null || p.total < maxLoss) maxLoss = p.total
  }
  return { maxProfit, maxLoss, used }
}

// -------------------------------------------------------------- daily rollup

/**
 * Where the day's closing `total` came from.
 *
 *  - `marks`    every open leg priced at rollup time.
 *  - `snapshot` the feed had already gone quiet (the rollup runs at 15:40,
 *    and `QuoteCache` correctly calls a feed with no ticks dead within two
 *    minutes), so the last intraday snapshot that DID price the book supplies
 *    the mark component. Realised still comes from the fills.
 *  - `none`     neither was available. `total` is null, and stays repairable.
 *
 * Recorded because "marked at the close" and "marked at the last good tick of
 * the afternoon" are different claims about the same rupee figure, and an
 * operator reconciling against a broker statement needs to know which one they
 * are looking at.
 */
export type ClosingSource = 'marks' | 'snapshot' | 'none'

export interface DailyReport {
  readonly date: string
  readonly tag: string
  readonly mode: 'paper' | 'live'
  /** NET of fees. */
  readonly realised: number
  /** Before fees. Equal to `realised` on a venue that charges none here (NSE). */
  readonly gross: number
  readonly fees: number
  readonly total: number | null
  readonly maxProfit: number | null
  readonly maxLoss: number | null
  readonly orderCount: number
  readonly closingPositions: number
  /** Snapshots the extremes were drawn from. 0 means both extremes are null. */
  readonly snapshots: number
  readonly closingSource: ClosingSource
  readonly writtenAt: number
}

export interface DailyReportInput {
  readonly date: string
  readonly tag: string
  readonly mode: 'paper' | 'live'
  readonly window: PnlWindow
  /** Marks at rollup time. Empty out of hours, which is normal, not an error. */
  readonly marks: Marks
  readonly series: readonly SeriesPoint[]
  readonly writtenAt: number
  readonly costs?: Costs
}

/**
 * Build one strategy's rollup for one IST trading day.
 *
 * REALISED IS ALWAYS RECOMPUTED FROM FILLS, never copied from a snapshot. That
 * is what makes a rollup missed while the process was down repairable rather
 * than a permanent hole (Phase B §5): the fills are still there, so the number
 * can be rebuilt exactly, days later, by calling this function again.
 *
 * Only the MARK component can ever fall back to a snapshot, because a mark is
 * the one input that cannot be reconstructed after the fact.
 */
export function buildDailyReport(input: DailyReportInput): DailyReport {
  const live = computeWindowPnl(input.window, input.marks, input.costs)
  const ext = extremes(input.series)

  let total = live.total
  let closingSource: ClosingSource = live.complete ? 'marks' : 'none'
  if (!live.complete) {
    /**
     * Borrow the last fully-marked snapshot's `unrealised` — but ONLY when
     * nothing was filled after it.
     *
     * `live.realised` is the END-OF-DAY figure while the borrowed `unrealised`
     * is a point-in-time one, so any leg that went open -> closed in between
     * lands in both terms and is counted TWICE. Traced: short PE 13125 @ 11,
     * last marked snapshot at 13:59 with the PE at 8 (unrealised 39,375),
     * bought back at 15:20 (realised 39,375) — the rollup reported ₹91,875
     * against a true ₹52,500, overstated by exactly the PE.
     *
     * This is not an edge case. The rollup runs at 15:40, the feed is declared
     * dead after 120s of silence, so `closingSource: 'snapshot'` is the NORMAL
     * path for a carried book — and the wrong figure is written to
     * `desk-daily-reports`, which is kept forever, while the snapshots that
     * would expose it are pruned at 30 days.
     *
     * `SeriesPoint` carries no per-leg marks, so no correct figure can be
     * reconstructed once the position set has moved. Reporting `null` is the
     * honest answer: "this day's close could not be marked" is a state the
     * operator can act on, a plausible wrong number is not.
     */
    const lastMarked = lastMarkedPoint(input.series)
    if (lastMarked !== null) {
      const filledAfter = input.window.during.some((f) => f.ts > lastMarked.ts)
      if (filledAfter) {
        total = null
        closingSource = 'none'
      } else {
        total = live.realised + lastMarked.unrealised
        closingSource = 'snapshot'
      }
    }
  }

  return {
    date: input.date,
    tag: input.tag,
    mode: input.mode,
    realised: live.realised,
    gross: live.gross,
    fees: live.fees,
    total,
    maxProfit: ext.maxProfit,
    maxLoss: ext.maxLoss,
    // Fills, not journal rows: the journal has no `mode` and paper never
    // reaches it, so counting it would report 0 orders for every paper day.
    orderCount: input.window.during.length,
    closingPositions: live.openLegs,
    snapshots: ext.used,
    closingSource,
    writtenAt: input.writtenAt,
  }
}

/**
 * The most recent snapshot that priced the WHOLE book, with its timestamp.
 *
 * The timestamp is the point: borrowing its `unrealised` is only sound if the
 * position set has not moved since, and that can only be checked against when
 * it was taken.
 */
function lastMarkedPoint(series: readonly SeriesPoint[]): { ts: number; unrealised: number } | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i]
    if (p !== undefined && p.unrealised !== null && Number.isFinite(p.unrealised)) {
      return { ts: p.ts, unrealised: p.unrealised }
    }
  }
  return null
}

// --------------------------------------------------------------- the prune

export interface DayActivity {
  readonly date: string
  readonly snapshots: number
  /**
   * `tag|mode` keys that were active that day — anything that traded OR was
   * snapshotted. Deliberately the union: a carried book that traded nothing but
   * was marked all day still has intraday detail worth summarising before it is
   * deleted.
   */
  readonly active: readonly string[]
  /** `tag|mode` keys that have a row in `desk-daily-reports` for that day. */
  readonly rolledUp: readonly string[]
}

export interface PruneDecision {
  readonly date: string
  readonly snapshots: number
  readonly action: 'delete' | 'skip'
  readonly reason: string
}

/**
 * Decide, per day, whether its snapshots may go.
 *
 * THE GUARD, and the reason this is a job and not a Mongo TTL index: a TTL
 * index deletes on a timestamp and cannot express "only if summarised". It
 * would cheerfully delete the intraday detail of a day whose rollup job never
 * ran because the process was down — and then the day is gone twice over, since
 * the rollup is recomputable from fills but the 15s series is recomputable from
 * nothing.
 *
 * So a day is deleted only when EVERY active strategy has a rollup row, and a
 * day that is skipped says which strategy is missing. A silent skip would leave
 * snapshots accumulating forever with nobody able to say why.
 */
export function planPrune(days: readonly DayActivity[]): PruneDecision[] {
  return days.map((d) => {
    if (d.snapshots === 0) {
      return { date: d.date, snapshots: 0, action: 'skip', reason: 'no snapshots to prune' }
    }
    const have = new Set(d.rolledUp)
    const missing = d.active.filter((k) => !have.has(k))
    if (missing.length > 0) {
      return {
        date: d.date,
        snapshots: d.snapshots,
        action: 'skip',
        reason: `no daily rollup for ${missing.join(', ')} — deleting would lose intraday detail that was never summarised`,
      }
    }
    return {
      date: d.date,
      snapshots: d.snapshots,
      action: 'delete',
      reason: `rolled up for ${d.active.length} strateg${d.active.length === 1 ? 'y' : 'ies'}`,
    }
  })
}

// ------------------------------------------------------------ session clock

/** Minutes since IST midnight. The host may be on UTC; this never asks it. */
export function istMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs + IST_OFFSET_MS)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** 0 = Sunday, IST. */
export function istWeekday(tsMs: number): number {
  return new Date(tsMs + IST_OFFSET_MS).getUTCDay()
}

export const MARKET_OPEN_MIN = 9 * 60 + 15

/**
 * Is the market open right now? 09:15 to before 15:40 IST, the F&O session
 * (core's `FNO_CLOSE_MIN`, since 3 Aug 2026): a desk book's options are
 * priced until then, so its P&L series is too. The end is exclusive so the
 * last snapshot lands before the 15:40 rollup (`rollupAfterIstMinutes`)
 * marks the book itself. Nothing here places an order.
 *
 * Gates the SNAPSHOT TICK only — never process boot. Booting behind a time
 * window is the 2026-07-06 defect (`strategy-kit/src/base.ts:105`): a pm2
 * restart at 09:15:30 came up asleep and stayed asleep all session. The job
 * starts unconditionally and each tick decides for itself.
 *
 * Exchange holidays are NOT modelled. A holiday tick computes P&L over a book
 * that did not move and writes a flat series — wasteful, harmless, and far
 * cheaper than a holiday calendar that goes stale and silently suppresses a
 * real trading day.
 */
export function inTradingSession(tsMs: number, venue: VenueSpec = API_VENUE): boolean {
  // A 24x7 venue is always in session: its book is priced every minute of the
  // week, so its series is too.
  if (!isNse(venue)) return venue.isOpen(tsMs)
  const day = istWeekday(tsMs)
  if (day === 0 || day === 6) return false
  const m = istMinutesOfDay(tsMs)
  return m >= MARKET_OPEN_MIN && m < FNO_CLOSE_MIN
}
