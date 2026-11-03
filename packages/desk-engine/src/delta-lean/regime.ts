/**
 * THE REGIME DETECTOR — what the index DID, against what the options were
 * CHARGING for it, over the same window.
 *
 * There are no indicators here and there is nothing to add. The ATM straddle
 * is the market's own quote for the expected absolute move to expiry; scaled
 * to a window by the square root of time it becomes the move the options were
 * priced for over that window. The index either beat that number or it did
 * not, and it either got there in a straight line or it wandered. Three
 * regimes fall out (spec §5):
 *
 *   TREND  |displacement| > `dl_trend_mult` x implied, on a path at least
 *          `dl_clean_min` clean. Direction is the sign of the displacement.
 *   QUIET  range inside `dl_quiet_mult` x implied, for TWO consecutive
 *          windows — the market is measurably doing less than it charges.
 *   CHOP   everything else: a large range that went nowhere.
 *
 * ── 1. THE SQUARE ROOT IS THE WHOLE BRIDGE ──────────────────────────────────
 * `implied(W) = straddle x sqrt(W_minutes / minutesToExpiry)`. Scale linearly
 * instead and a 60-second window is compared against a bar five times too
 * high, so nothing is ever a trend and the book sits out the day; invert it
 * and everything is a trend and the book leans into noise. Neither failure
 * throws, and both look like a bad strategy rather than a bad exponent —
 * which is why `impliedWindowMove` is its own function with its own test.
 *
 * ── 2. ABSENT IS NEVER CALM ─────────────────────────────────────────────────
 * Every path that cannot produce an honest reading returns `'unknown'`, and
 * `'unknown'` opens nothing. It must NEVER degrade to `'quiet'`, because quiet
 * is the one regime that SELLS premium: a strangle sold into a chain that
 * stopped printing is the worst thing this module can cause. So a missing
 * straddle, an unpriced side of the ATM strike, a window holding fewer than
 * `MIN_SAMPLES` ticks, a window whose ticks span less than `MIN_SPAN_FRAC` of
 * it, and a quiet window with no prior window to confirm it are all
 * `'unknown'` rather than any classification at all.
 *
 * ── 3. THE HYSTERESIS IS ASYMMETRIC ON PURPOSE ──────────────────────────────
 * Quiet-to-trend is immediate: that break is the whole reason the book exists.
 * Trend-to-anything needs the ratio to fall through the LOWER
 * `dl_trend_exit_mult` (1.2 against 2.0) AND `dl_regime_dwell_s` of dwell in
 * the trend. `classifyWindow` carries the first half through `wasTrending`;
 * the dwell needs a clock and prior state, so it lives in `readRegime`.
 * Leaving the regime is NOT the same as cutting risk — the drawdown and
 * lean-max-loss cuts in the controller are regime-independent — so holding a
 * stale trend label for two minutes costs sizing, never a stop.
 *
 * Pure: no clock, no IO, no `Date.now()`. `nowMs` is always a parameter.
 */

import type { Dials } from '../dials.ts';
import { midOf } from '../marking.ts';
import type { ChainSnap, Quote, StrikeQuote } from '../types.ts';

export interface SpotSample {
  readonly ms: number;
  readonly spot: number;
}

export interface WindowStat {
  readonly displacement: number; // last - first, signed
  readonly range: number; // high - low
  readonly cleanliness: number; // |displacement| / range; 0 when range is 0
  readonly samples: number;
  readonly spanMs: number;
}

/**
 * What `SpotRing.range` says about an interval: its extremes, its two ends and
 * how much of the interval the samples actually cover.
 *
 * `spanMs` and `samples` are reported rather than judged, because the callers
 * judge coverage differently — the session fold takes whatever there is, while
 * a calm filter or a breakout box must cover most of its window or mean
 * nothing. A thin interval is therefore the caller's decision, and an EMPTY
 * one is `null`, never a zeroed range that reads as a flat market.
 */
export interface SpotRange {
  readonly hi: number;
  readonly lo: number;
  /** The oldest sample in the interval, and the newest. */
  readonly first: number;
  readonly last: number;
  readonly firstMs: number;
  readonly lastMs: number;
  readonly samples: number;
  /** `lastMs - firstMs`: 0 for a single sample. */
  readonly spanMs: number;
}

/**
 * `SpotRing.filteredRange`'s answer: a `SpotRange` whose `hi`/`lo` are the
 * extremes of the running median-of-3 rather than of the raw prints, plus the
 * longest hole between two consecutive samples. Every other field is the raw
 * tape's, exactly as `range` reports it.
 */
export interface FilteredSpotRange extends SpotRange {
  /** The longest gap between two consecutive samples in the interval, in ms.
   * 0 for a single sample. */
  readonly maxGapMs: number;
}

/** The median of three numbers. */
function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

export type Regime = 'trend-up' | 'trend-down' | 'quiet' | 'chop' | 'unknown';

export interface RegimeRead {
  readonly fast: Regime;
  readonly slow: Regime;
  readonly context: Regime;
  readonly fastStat: WindowStat | null;
  readonly slowStat: WindowStat | null;
  readonly impliedSlow: number | null;
  readonly agrees: boolean; // slow and context point the same way
}

/**
 * The fewest ticks a window may be summarised from.
 *
 * The feed samples about once a second, so even the 60-second fast window sees
 * ~60 — eight is not a throughput bar, it is a floor under the ARITHMETIC. A
 * range built from two or three prints is one print wide, so a single bad tick
 * sets both the high and the displacement and the window reads as a clean
 * trend; at eight, no single print can be more than a small part of either.
 * Eight also clears in eight seconds of feed, so it costs nothing at warm-up.
 */
export const MIN_SAMPLES = 8;

/**
 * The fraction of the window the surviving ticks must actually span.
 *
 * A count alone does not make a window. Forty ticks crammed into the last
 * twenty seconds of a five-minute window would be summarised as a five-minute
 * move and compared against a five-minute implied — an over-read of
 * sqrt(300/20), about 3.9x, which turns an ordinary wobble into a "trend" the
 * book leans into. Half is the loosest bar that still forces the samples to
 * describe the window rather than its tail, and it tolerates the gaps a real
 * feed leaves without going blind.
 */
export const MIN_SPAN_FRAC = 0.5;

function isTrend(r: Regime): boolean {
  return r === 'trend-up' || r === 'trend-down';
}

/**
 * A fixed-capacity circular buffer of spot ticks, owned by the host and shared
 * by every book on the symbol.
 *
 * Non-finite samples are dropped at the door rather than stored: one NaN print
 * poisons `displacement`, every NaN comparison is false, and a poisoned window
 * classifies as `'chop'` forever instead of `'unknown'` — a silent failure
 * dressed as a decision.
 */
export class SpotRing {
  readonly #buf: Array<SpotSample | undefined>;
  #written = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError(`SpotRing capacity must be >= 1, got ${capacity}`);
    }
    this.#buf = new Array<SpotSample | undefined>(Math.floor(capacity));
  }

  push(s: SpotSample): void {
    if (!Number.isFinite(s.ms) || !Number.isFinite(s.spot)) return;
    this.#buf[this.#written % this.#buf.length] = s;
    this.#written += 1;
  }

  get size(): number {
    return Math.min(this.#written, this.#buf.length);
  }

  /**
   * The newest sample written, or `null` on an empty ring.
   *
   * The playbooks' `S` (six-playbooks spec §4.2): the index level every
   * index-based rule reads. `null`, never a zero sample, when nothing has been
   * pushed — a 0 index would put every stop distance at the whole index.
   */
  latest(): SpotSample | null {
    if (this.#written === 0) return null;
    return this.#buf[(this.#written - 1) % this.#buf.length] ?? null;
  }

  /**
   * Summarise every sample with `fromMs <= ms <= toMs` — both ends inclusive —
   * or `null` when there is none, when `fromMs > toMs`, or when a bound is not
   * a number.
   *
   * Walks back from the newest sample exactly as `window` does: a sample ahead
   * of `toMs` is skipped and the walk goes on, and the first sample older than
   * `fromMs` ends it, because samples are pushed in time order and everything
   * behind it is older still. A slot the ring has overwritten holds a NEWER
   * sample, so an interval the ring no longer covers comes back `null` rather
   * than as a value read out of a reused slot.
   *
   * Unlike `window`, it applies no sample or span floor of its own: the
   * session fold wants whatever the ring holds, and the callers that need
   * coverage test `samples` and `spanMs` themselves (see `SpotRange`).
   */
  range(fromMs: number, toMs: number): SpotRange | null {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return null;
    const cap = this.#buf.length;
    const held = this.size;

    let newest: SpotSample | null = null;
    let oldest: SpotSample | null = null;
    let hi = -Infinity;
    let lo = Infinity;
    let samples = 0;

    for (let back = 1; back <= held; back += 1) {
      const s = this.#buf[(this.#written - back) % cap];
      if (s === undefined) break;
      if (s.ms > toMs) continue; // after the interval: skip it, the older ones may be in
      if (s.ms < fromMs) break; // before it — and so is everything behind this one
      if (newest === null) newest = s;
      oldest = s;
      if (s.spot > hi) hi = s.spot;
      if (s.spot < lo) lo = s.spot;
      samples += 1;
    }

    if (newest === null || oldest === null) return null;
    return {
      hi,
      lo,
      first: oldest.spot,
      last: newest.spot,
      firstMs: oldest.ms,
      lastMs: newest.ms,
      samples,
      spanMs: newest.ms - oldest.ms,
    };
  }

  /**
   * `range`, with the extremes taken over the RUNNING MEDIAN-OF-3 — so ONE BAD
   * PRINT CAN NEVER BECOME AN EXTREME — and with the longest hole in the tape.
   *
   * The day's high and low are what the playbooks measure excursions, boxes
   * and new-extreme stops from, and they are persisted. A single bad index
   * print folded into them stays wrong for the rest of the session: a phantom
   * high is an excursion that never happened, and a reversal faded off it.
   * So each sample in the interval, taken in time order, is replaced by the
   * median of itself and its two neighbours, and `hi`/`lo` are the extremes
   * of THOSE values. An edge sample has only one neighbour inside the
   * interval and uses that neighbour's median — the median of the three
   * prints nearest the edge. Every filtered value is then the median of three
   * consecutive prints, so one bad print is always outvoted two to one,
   * wherever it sits. (Taking the neighbour's RAW value instead would let a
   * bad print beside the edge leak out through it.) That holds for three
   * samples or more; with one or two there is no third print to outvote
   * anything, and they are reported as they are.
   *
   * `first`, `last`, the times, the count and the span are the RAW tape's, as
   * `range` reports them. `maxGapMs` is the longest gap between consecutive
   * samples in the interval, and it is the caller's measure of whether the
   * extremes can be trusted at all: a tape with a hole may have missed the
   * very move its high should hold.
   */
  filteredRange(fromMs: number, toMs: number): FilteredSpotRange | null {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return null;
    const cap = this.#buf.length;
    const held = this.size;

    // The interval's samples, newest first (the walk is `range`'s).
    const back: SpotSample[] = [];
    for (let i = 1; i <= held; i += 1) {
      const s = this.#buf[(this.#written - i) % cap];
      if (s === undefined) break;
      if (s.ms > toMs) continue;
      if (s.ms < fromMs) break;
      back.push(s);
    }
    const n = back.length;
    if (n === 0) return null;
    const tape = back.reverse(); // time order, oldest first
    const at = (i: number): SpotSample => tape[i] as SpotSample;

    let hi = -Infinity;
    let lo = Infinity;
    let maxGapMs = 0;
    for (let i = 0; i < n; i += 1) {
      let filtered = at(i).spot; // one or two prints: nothing to outvote
      if (n >= 3) {
        // The window's centre: the sample itself, or for an edge its one
        // neighbour, so the window always holds three real prints.
        const c = Math.min(Math.max(i, 1), n - 2);
        filtered = median3(at(c - 1).spot, at(c).spot, at(c + 1).spot);
      }
      if (filtered > hi) hi = filtered;
      if (filtered < lo) lo = filtered;
      if (i > 0) maxGapMs = Math.max(maxGapMs, at(i).ms - at(i - 1).ms);
    }

    const first = at(0);
    const last = at(n - 1);
    return {
      hi,
      lo,
      first: first.spot,
      last: last.spot,
      firstMs: first.ms,
      lastMs: last.ms,
      samples: n,
      spanMs: last.ms - first.ms,
      maxGapMs,
    };
  }

  /**
   * Summarise `[nowMs - windowS*1000, nowMs]`, walking back from the newest
   * sample until one falls before the cutoff. `null` — never a zeroed stat —
   * when the window is too thin or too short to describe (see `MIN_SAMPLES`
   * and `MIN_SPAN_FRAC`): a zeroed stat reads as a flat market, which is the
   * one reading that sells premium.
   */
  window(nowMs: number, windowS: number): WindowStat | null {
    if (!Number.isFinite(nowMs) || !(windowS > 0)) return null;
    const cutoff = nowMs - windowS * 1000;
    const cap = this.#buf.length;
    const held = this.size;

    let newest: SpotSample | null = null;
    let oldest: SpotSample | null = null;
    let hi = -Infinity;
    let lo = Infinity;
    let samples = 0;

    for (let back = 1; back <= held; back += 1) {
      const s = this.#buf[(this.#written - back) % cap];
      if (s === undefined) break;
      if (s.ms > nowMs) continue; // a tick ahead of the clock is not in this window
      if (s.ms < cutoff) break; // samples are pushed in time order; the rest are older still
      if (newest === null) newest = s;
      oldest = s;
      if (s.spot > hi) hi = s.spot;
      if (s.spot < lo) lo = s.spot;
      samples += 1;
    }

    if (newest === null || oldest === null) return null;
    if (samples < MIN_SAMPLES) return null;
    const spanMs = newest.ms - oldest.ms;
    if (spanMs < windowS * 1000 * MIN_SPAN_FRAC) return null;

    const displacement = newest.spot - oldest.spot;
    const range = hi - lo;
    return {
      displacement,
      range,
      cleanliness: range > 0 ? Math.abs(displacement) / range : 0,
      samples,
      spanMs,
    };
  }
}

/**
 * The move the options were priced for over a window of `windowS` seconds.
 *
 * `null` — not 0 — when there is no straddle or no time left: no implied move
 * means nothing to compare the tape against, and a 0 bar would make every
 * flicker a trend.
 */
export function impliedWindowMove(
  straddleMid: number,
  minutesToExpiry: number,
  windowS: number,
): number | null {
  if (!(straddleMid > 0) || !(minutesToExpiry > 0) || !(windowS > 0)) return null;
  return straddleMid * Math.sqrt(windowS / 60 / minutesToExpiry);
}

function midOrNull(q: Quote | null): number | null {
  return q === null ? null : midOf(q);
}

/**
 * The ATM straddle mid: the market's expected absolute move to expiry.
 *
 * The strike nearest `chain.spot` wins; ties go to the lower strike, which the
 * ascending ladder gives for free. `null` when either side of that strike is
 * unpriced — half a straddle is not a cheap straddle, it is no reading at all,
 * and the caller turns that into `'unknown'`.
 */
export function atmStraddleMid(chain: ChainSnap): number | null {
  let best: StrikeQuote | null = null;
  let bestGap = Infinity;
  for (const row of chain.strikes) {
    const gap = Math.abs(row.strike - chain.spot);
    if (gap < bestGap) {
      bestGap = gap;
      best = row;
    }
  }
  if (best === null) return null;
  const ce = midOrNull(best.ce);
  const pe = midOrNull(best.pe);
  if (ce === null || pe === null) return null;
  const straddle = ce + pe;
  return Number.isFinite(straddle) && straddle > 0 ? straddle : null;
}

/**
 * One window's regime. Stateless by design — `wasTrending` is the ONLY memory
 * it has, and it carries exactly one thing: which trend bar applies.
 *
 * The two-consecutive-windows half of the quiet rule (spec §5) needs a second
 * window and therefore lives in `readRegime`; this function answers only "what
 * is THIS window".
 */
export function classifyWindow(
  stat: WindowStat | null,
  implied: number | null,
  dials: Dials,
  wasTrending: boolean,
): Regime {
  // Absent data is 'unknown'. It must never fall through to 'quiet', which is
  // the one regime that SELLS premium.
  if (stat === null || implied === null || !(implied > 0)) return 'unknown';
  if (stat.samples < MIN_SAMPLES) return 'unknown';
  if (!Number.isFinite(stat.displacement) || !Number.isFinite(stat.range)) return 'unknown';
  const mult = wasTrending ? dials.dl_trend_exit_mult : dials.dl_trend_mult;
  const ratio = Math.abs(stat.displacement) / implied;
  if (ratio >= mult && stat.cleanliness >= dials.dl_clean_min) {
    return stat.displacement > 0 ? 'trend-up' : 'trend-down';
  }
  if (stat.range <= dials.dl_quiet_mult * implied) return 'quiet';
  return 'chop';
}

/**
 * All three windows at once (spec §5): fast gives DIRECTION, slow gives the
 * REGIME, context modulates size and flips.
 *
 * `prev` is the book's last regime and does two jobs: it lowers the slow
 * window's trend bar to `dl_trend_exit_mult`, and with `prevSinceMs` it holds
 * a trend for `dl_regime_dwell_s` before it may be left at all.
 *
 * `prevSinceMs` is the epoch ms the book entered `prev` (`RuleState.
 * dlRegimeSinceMs`). It is optional so the published signature stays callable
 * as the plan writes it; ABSENT means "start time unknown", and an unknown
 * start does not earn a dwell — the hold is skipped, which is the churn-prone
 * side rather than the risk-prone one.
 *
 * Three deliberate asymmetries:
 *
 *   - Only the SLOW window gets `wasTrending`. Fast is direction, and lowering
 *     its bar would make the direction it reports stickier than the tape.
 *     Context is the disagreement check behind the pyramiding cap, and a
 *     context window softened by the book's own prior belief would agree with
 *     that belief exactly when the gate exists to contradict it.
 *   - The dwell holds a trend against a contrary CLASSIFICATION, never against
 *     `'unknown'`. Suppressing reclassification noise is its job; inventing a
 *     reading out of a dead window is not.
 *   - `agrees` is true when context is OFF. Spec §6: with `dl_context_on`
 *     off, all four context roles are inert — an inert gate does not cap.
 */
export function readRegime(
  ring: SpotRing,
  chain: ChainSnap,
  nowMs: number,
  minutesToExpiry: number,
  dials: Dials,
  prev: Regime,
  prevSinceMs: number | null = null,
): RegimeRead {
  const straddle = atmStraddleMid(chain);
  const implied = (windowS: number): number | null =>
    straddle === null ? null : impliedWindowMove(straddle, minutesToExpiry, windowS);

  const slowS = dials.dl_slow_window_s;
  const impliedFast = implied(dials.dl_fast_window_s);
  const impliedSlow = implied(slowS);
  const impliedContext = implied(dials.dl_context_window_s);

  const fastStat = ring.window(nowMs, dials.dl_fast_window_s);
  const slowStat = ring.window(nowMs, slowS);

  const fast = classifyWindow(fastStat, impliedFast, dials, false);
  let slow = classifyWindow(slowStat, impliedSlow, dials, isTrend(prev));

  // Quiet takes TWO consecutive windows (spec §5). One calm five minutes at
  // the end of a violent fifteen is the eye of the storm, and this is the
  // regime that sells premium into it. With no prior window to confirm with,
  // the reading is withheld ('unknown' opens nothing) rather than downgraded
  // to 'chop', which would unwind a book on missing data.
  if (slow === 'quiet') {
    const priorStat = ring.window(nowMs - slowS * 1000, slowS);
    const prior = classifyWindow(priorStat, impliedSlow, dials, false);
    if (prior !== 'quiet') slow = prior === 'unknown' ? 'unknown' : 'chop';
  }

  // The dwell: a trend may not be left inside `dl_regime_dwell_s` of entering
  // it. This holds the LABEL only — the controller's drawdown and
  // lean-max-loss cuts do not consult the regime.
  if (
    isTrend(prev) &&
    slow !== prev &&
    slow !== 'unknown' &&
    prevSinceMs !== null &&
    Number.isFinite(prevSinceMs) &&
    nowMs - prevSinceMs < dials.dl_regime_dwell_s * 1000
  ) {
    slow = prev;
  }

  const contextOn = dials.dl_context_on;
  const contextStat = contextOn ? ring.window(nowMs, dials.dl_context_window_s) : null;
  const context = contextOn ? classifyWindow(contextStat, impliedContext, dials, false) : 'unknown';
  const agrees = contextOn ? isTrend(slow) && slow === context : true;

  return { fast, slow, context, fastStat, slowStat, impliedSlow, agrees };
}
