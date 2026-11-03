/**
 * WHAT ONE BOOK COSTS TO HOLD, at the broker that is actually holding it.
 *
 * Lifted out of `routes/desk.ts` unchanged when the payoff cockpit arrived, for
 * one reason: two readers now need this figure. The margin tile renders it, and
 * the cockpit's machine card divides it by the book's `margin_cap` to say
 * whether the bot's shift gate is open. A second copy of the arithmetic would
 * put two different "margin used" numbers on one screen — which is the exact
 * class of defect the desk keeps finding (a tile and a chip disagreeing by five
 * percent, with nothing on either to say which is right).
 *
 * The parts and why they are what they are:
 *
 *   SPAN + EXPOSURE come from `desk-book-margin`, priced through Zerodha's own
 *   basket endpoint by desk-marketdata. They are ZERODHA's rates.
 *
 *   THE CALIBRATION turns them into the rates the account is actually charged.
 *   The account is held at Jainam via XTS, measured 2026-08-04 at x1.0500 on
 *   span and x1.0484 on exposure. It is derived live from the broker snapshot
 *   rather than hardcoded, so it re-derives itself the day the broker changes.
 *
 *   PREMIUM PAID is part of the requirement. Zerodha's calculator itemises it
 *   separately; the XTS account BLOCKS it, and `MarginUsed` reconciled to
 *   `span + exposure + premiumPaid` exactly. A book's cost is what the broker
 *   takes, not what a calculator lists.
 *
 * Everything here is a READ. Neither function talks to a broker: desk-marketdata
 * owns the Kite session and publishes into Mongo, because two processes logging
 * into one Kite account invalidate each other's token — the 2026-08-04 outage.
 */

import { COLLECTIONS, type Database } from './store.ts'

/** A book-margin figure older than this is shown with its age rather than bare. */
export const BOOK_MARGIN_STALE_MS = 30 * 60_000

/**
 * A calibration this far from 1.0 is not a broker rate, it is a bug.
 *
 * The ratio is only meaningful while every live book has priced. If one has
 * not, its span is missing from the denominator and the survivors absorb its
 * share — which inflates them without any error being raised. These bounds turn
 * that into a fall-back-to-uncalibrated instead of a confidently wrong figure.
 */
const CALIBRATION_MIN = 0.8
const CALIBRATION_MAX = 1.5

export interface Calibration {
  readonly spanRatio: number
  readonly exposureRatio: number
}

/** The one collection this module reads, as a port. `ApiDeps` satisfies it. */
export interface MarginDeps {
  readonly db: Database
}

/**
 * A finite number out of whatever the broker typed it as.
 *
 * XTS quotes money as a STRING on some endpoints and a number on others, and
 * the string form carries grouping commas. A `Number('1,24,000')` is NaN, which
 * would render as "no margin data" over a perfectly good figure — the one
 * reading that makes a utilisation tile worse than no tile.
 */
export function numeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v.replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

/**
 * The first number under a key the pattern matches, anywhere in a bounded
 * subtree.
 *
 * A SEARCH RATHER THAN A PATH, deliberately. XTS buries the margin figures at
 * `BalanceList[0].limitObject.RMSSubLimits.marginUtilized`, and that path
 * differs between investor and dealer replies and between vendors — a hard-coded
 * one silently answers null the day it moves, which reads exactly like "this
 * account has no margin data". Searching by key name survives the reshuffle;
 * the depth cap keeps a hostile or huge document from costing anything.
 */
export function findNumber(root: unknown, pattern: RegExp, depth = 6): number | null {
  if (depth <= 0 || root === null || typeof root !== 'object') return null
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findNumber(item, pattern, depth - 1)
      if (found !== null) return found
    }
    return null
  }
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (pattern.test(key)) {
      const n = numeric(value)
      if (n !== null) return n
    }
  }
  // Only after every key at THIS level has been tried, so a nested
  // `marginUtilized` never wins over the one on the object we were handed.
  for (const value of Object.values(root as Record<string, unknown>)) {
    const found = findNumber(value, pattern, depth - 1)
    if (found !== null) return found
  }
  return null
}

/**
 * WHAT THE BROKER ACTUALLY CHARGES, not what Zerodha would.
 *
 * SELF-CALIBRATING, NOT A CONSTANT. XTS publishes its own `TotalSpanMargin` and
 * `ExposureMarginPresent` for the whole account, and the sum of the per-book
 * Zerodha figures is the matching denominator — so the ratio is observable
 * live. Hardcoding 1.05 would be fitting a constant to one afternoon; an
 * earlier guess of "x1.20 on span" from the same data was wrong by 67k, which
 * is exactly the failure mode this avoids.
 *
 * Returns null when it cannot be computed honestly — the caller then serves the
 * uncalibrated figure and says so, rather than inventing a multiplier.
 */
export async function brokerCalibration(deps: MarginDeps): Promise<Calibration | null> {
  const snap = (await deps.db
    .collection('desk-broker-snapshot')
    .findOne({ _id: 'xts' })) as Record<string, unknown> | null
  if (snap === null) return null
  const funds = snap['funds'] ?? snap['balance'] ?? null
  if (funds === null || typeof funds !== 'object') return null
  const xtsSpan = findNumber(funds, /^TotalSpanMargin$/i)
  const xtsExposure = findNumber(funds, /^ExposureMarginPresent$/i)
  if (xtsSpan === null || xtsExposure === null || xtsSpan <= 0 || xtsExposure <= 0) return null

  // The denominator: every book the broker is holding margin against.
  const docs = (await deps.db
    .collection(COLLECTIONS.bookMargin)
    .find({ ok: true })
    .toArray()) as Record<string, unknown>[]
  let span = 0
  let exposure = 0
  for (const d of docs) {
    span += Number(d['span'] ?? 0)
    exposure += Number(d['exposure'] ?? 0)
  }
  if (span <= 0 || exposure <= 0) return null
  const spanRatio = xtsSpan / span
  const exposureRatio = xtsExposure / exposure
  if (spanRatio < CALIBRATION_MIN || spanRatio > CALIBRATION_MAX) return null
  if (exposureRatio < CALIBRATION_MIN || exposureRatio > CALIBRATION_MAX) return null
  return { spanRatio, exposureRatio }
}

export interface BrokerFigures {
  readonly brokerSpan: number
  readonly brokerExposure: number
  readonly premiumPaid: number
  /** THE HEADLINE: what this book costs at the broker actually holding it. */
  readonly brokerTotal: number
}

/**
 * One `desk-book-margin` document plus the account's calibration, as the one
 * rupee figure both the tile and the machine card must agree on.
 *
 * Uncalibrated (`cal === null`) it is still the right SHAPE — span + exposure +
 * premium paid — just at Zerodha's rates; the caller says which.
 */
export function brokerFigures(
  doc: Record<string, unknown>,
  cal: Calibration | null,
): BrokerFigures {
  const brokerSpan = Number(doc['span'] ?? 0) * (cal?.spanRatio ?? 1)
  const brokerExposure = Number(doc['exposure'] ?? 0) * (cal?.exposureRatio ?? 1)
  const premiumPaid = Number(doc['premiumPaid'] ?? 0)
  return {
    brokerSpan,
    brokerExposure,
    premiumPaid,
    brokerTotal: brokerSpan + brokerExposure + premiumPaid,
  }
}
