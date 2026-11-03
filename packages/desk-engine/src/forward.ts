/**
 * THE WEEKLY'S OWN FORWARD — put-call parity off the book's own chain
 * (six-playbooks spec F1).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `ChainSnap.spot` is the forward every ATM, every delta and every band strike
 * is picked off, and it was the near-month FUTURE's mid for every book. A
 * weekly does not expire with the monthly future: its own forward sat a median
 * 308 points below the future on SENSEX (15-561) and 35-71 points below it on
 * NIFTY (spec §1.3). The 1 Oct condor's "≤0.30Δ" short 72400 PE was 27 points
 * from the true forward — at the money — and every greek on the book said
 * otherwise. The options themselves know their forward, and this reads it.
 *
 * ── THE ARITHMETIC ──────────────────────────────────────────────────────────
 * Black-76 parity on a forward: `C - P = e^{-rT} (F - K)`, so each strike
 * implies `F_K = K + (C_mid - P_mid) e^{rT}`, with `r = RISK_FREE` and
 * `T = yearFrac` — the same rate and the same tenor every greek on this desk is
 * priced at (`marking.ts`), so the forward and the greeks read off it cannot
 * disagree about time.
 *
 * ── WHY SIX STRIKES, A MEDIAN, AND THREE GATES ──────────────────────────────
 * Parity is exact in theory and noisy in a book: a wing quoted wide, a wing
 * that stopped updating, or one fat-fingered quote each move one strike's
 * `F_K` by its error. So the read is built to IGNORE a bad strike rather than
 * average it in:
 *
 *   - the `PARITY_STRIKES` strikes NEAREST THE INDEX — the liquid ones, where
 *     both wings carry time value — and no others, even when some of the six
 *     fail: reaching further out for a count is reaching into the strikes
 *     whose quotes are least worth reading;
 *   - a strike counts only if BOTH wings are two-sided, no more than
 *     `PARITY_QUOTE_AGE_MS` old, and no wider than max(3% of mid, ₹2): a stale
 *     or wide wing is exactly the error parity cannot see;
 *   - the MEDIAN of what survives, over at least `PARITY_MIN_STRIKES`. One
 *     outlier among six cannot move a median at all, where it moves a mean by
 *     a sixth of itself;
 *   - and a SANITY BAND, `|F - index| <= max(0.6% x index, 2 x step)`. A
 *     weekly's carry and basis are tens of points; a "forward" 1% from the
 *     index is a broken quote set, and the right answer is no read.
 *
 * `null` is a real answer, and the host has a fallback for it (spec F1:
 * `carryForward`, then the future mid). It is never a guess: a forward that is
 * wrong is worse than one that is approximate, because every strike of every
 * package is chosen off it.
 *
 * PURE: no clock, no feed, no Mongo. `nowMs` and the dates are arguments, so a
 * fixture can replay a session that is long over.
 */
import { midOf, RISK_FREE, yearFrac } from './marking.ts';
import type { Quote, StrikeQuote } from './types.ts';

/**
 * Which source priced a chain's `spot` (spec F1): its own parity forward, the
 * index carried over the contract's tenor, the future's mid, or the proxy a
 * view without an index falls back to. Only the first two are the weekly's
 * own forward.
 */
export type ForwardSource = 'parity' | 'index-carry' | 'future' | 'proxy';

/** How many listed strikes nearest the index the read is taken over. */
export const PARITY_STRIKES = 6;
/** The fewest usable strikes a median is taken over; below it, no read. */
export const PARITY_MIN_STRIKES = 3;
/** The oldest a wing's quote may be, against `nowMs`, and still count. */
export const PARITY_QUOTE_AGE_MS = 10_000;

/** A wing counts only inside max(`SPREAD_FRAC` x mid, `SPREAD_FLOOR_INR`):
 * proportional on a rich option, a rupee floor on a cheap one, where a
 * percentage bar would refuse a one-tick market. */
const SPREAD_FRAC = 0.03;
const SPREAD_FLOOR_INR = 2;

/** The sanity band: max(`BAND_FRAC` x index, `BAND_STEPS` x step). */
const BAND_FRAC = 0.006;
const BAND_STEPS = 2;

export interface ForwardInput {
  /** The chain's strike rows — any order; the read picks its own six. */
  readonly strikes: ReadonlyArray<StrikeQuote>;
  /** The index level the six strikes are chosen around. > 0. */
  readonly index: number;
  /** The chain's strike step, for the sanity band. > 0. */
  readonly step: number;
  /** The clock every wing's age is measured against. */
  readonly nowMs: number;
  /** The IST date, the contract's expiry and the IST minute: the tenor
   * `yearFrac` prices the carry at. */
  readonly dateIst: string;
  readonly expiry: string;
  readonly minuteOfDay: number;
}

export interface ForwardRead {
  readonly forward: number;
  /** How many of the six strikes the median was taken over (3-6). */
  readonly strikesUsed: number;
}

/**
 * One wing's mid, or `null` when the wing may not count: no quote, a
 * one-sided book, a locked or crossed one, a quote older than
 * `PARITY_QUOTE_AGE_MS`, a spread past the bar, or a number that is not one.
 *
 * Judged on the QUOTE, never on `ltp`: a last print says what someone paid,
 * not where the book is, and parity on a print is parity on the past.
 */
function wingMid(q: Quote | null, nowMs: number): number | null {
  if (q === null) return null;
  const { bid, ask, asOf } = q;
  if (bid === null || ask === null) return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(asOf)) return null;
  if (!(ask > bid)) return null;
  if (nowMs - asOf > PARITY_QUOTE_AGE_MS) return null;
  const mid = midOf(q);
  if (mid === null || !Number.isFinite(mid)) return null;
  if (ask - bid > Math.max(SPREAD_FRAC * mid, SPREAD_FLOOR_INR)) return null;
  return mid;
}

/** The median of an ASCENDING list: the middle value, or the mean of the
 * middle two. `null` for an empty list. */
function median(sorted: readonly number[]): number | null {
  const n = sorted.length;
  const lo = sorted[Math.floor((n - 1) / 2)];
  const hi = sorted[Math.floor(n / 2)];
  if (lo === undefined || hi === undefined) return null;
  return (lo + hi) / 2;
}

/**
 * The parity forward of the chain's own expiry, or `null` when the chain
 * cannot give an honest one (see the header for every gate).
 *
 * The six candidates are the listed strikes nearest `index`, ties to the LOWER
 * strike; they are chosen BEFORE any is judged, so a candidate that fails its
 * quote test costs the read a strike rather than pulling in a seventh.
 *
 * A non-finite or non-positive `index` or `step`, a non-finite clock, or a
 * strike that is not a number anywhere on the ladder is `null`: there is no
 * "nearest six" on a ladder that cannot be ordered. A date pair `yearFrac`
 * cannot read prices the carry at T = 0, a factor of 1 — on a weekly, a
 * fraction of a point.
 */
export function parityForward(input: ForwardInput): ForwardRead | null {
  const { strikes, index, step, nowMs, dateIst, expiry, minuteOfDay } = input;
  if (!(Number.isFinite(index) && index > 0)) return null;
  if (!(Number.isFinite(step) && step > 0)) return null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(minuteOfDay)) return null;
  if (strikes.some((row) => !Number.isFinite(row.strike))) return null;

  const candidates = [...strikes]
    .sort((a, b) => Math.abs(a.strike - index) - Math.abs(b.strike - index) || a.strike - b.strike)
    .slice(0, PARITY_STRIKES);

  const carry = Math.exp(RISK_FREE * yearFrac(dateIst, expiry, minuteOfDay));
  const implied: number[] = [];
  for (const row of candidates) {
    const c = wingMid(row.ce, nowMs);
    const p = wingMid(row.pe, nowMs);
    if (c === null || p === null) continue;
    implied.push(row.strike + (c - p) * carry);
  }
  if (implied.length < PARITY_MIN_STRIKES) return null;

  const forward = median(implied.sort((a, b) => a - b));
  if (forward === null || !Number.isFinite(forward)) return null;
  if (Math.abs(forward - index) > Math.max(BAND_FRAC * index, BAND_STEPS * step)) return null;
  return { forward, strikesUsed: implied.length };
}

/**
 * The fallback forward (spec F1, step 2): the index carried at the desk rate
 * over the contract's tenor, `index x e^{rT}`.
 *
 * What the forward of an index with no dividend in the window IS, and so the
 * right answer when the chain cannot price parity: unlike the monthly future it
 * replaces, it is carried over the weekly's OWN tenor. The host calls it only
 * with an index level it holds, and it returns a plain number: there is nothing
 * in it to refuse.
 */
export function carryForward(
  index: number,
  dateIst: string,
  expiry: string,
  minuteOfDay: number,
): number {
  return index * Math.exp(RISK_FREE * yearFrac(dateIst, expiry, minuteOfDay));
}
