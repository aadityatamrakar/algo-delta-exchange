/**
 * THE SESSION FOLD — the day's open, its filtered high and low, the longest
 * hole in the tape and `Dday`, carried in `RuleState.pb` (six-playbooks spec
 * §4.2, §4.4, F5).
 *
 * WHY IT IS FOLDED INTO STATE AND NOT READ OFF THE RING. The ring is the
 * host's memory and dies with the process; a reversal faded off the morning's
 * high, or a stop measured from the open, must survive a restart at 11:00. So
 * the four statistics are folded into the persisted row as the tape arrives,
 * and the ring is only where the next fold reads from.
 *
 * ── ONE BAD PRINT IS NEVER AN EXTREME (spec M11) ────────────────────────────
 * The high and low are taken over `SpotRing.filteredRange`, the extremes of
 * the RUNNING MEDIAN-OF-3, so a lone spike is outvoted by its neighbours, and
 * the OPEN is the median of the session's first three prints — a bad 09:15:00
 * tick would otherwise be the level every gap gate and excursion reads all
 * day, with nothing to re-derive it. That
 * only works with neighbours in the window, and a pass every second sees one
 * or two new prints. So each fold re-reads `OVERLAP_MS` behind its resume
 * point: every new print is filtered against real prints either side of it,
 * and re-reading prints already folded is harmless, because a max of a max is
 * the same max. A window with fewer than three prints in it — there is no
 * third print to outvote anything — is not folded at all, and waits for one.
 *
 * ── A QUIET PASS WRITES NOTHING ─────────────────────────────────────────────
 * `sameRuleState` is `JSON.stringify` equality, and a field that moved on
 * every pass would be a Mongo write on every pass, for every book. So the fold
 * writes ONLY WHEN A STATISTIC CHANGES — the open, a new extreme, a longer
 * hole, `Dday` — and returns the SAME object otherwise. The resume point,
 * `statsLastMs`, rides along on those writes, and on a tape that makes no new
 * extreme for `CHECKPOINT_MS` it is checkpointed anyway, so a calm afternoon
 * re-reads at most five minutes of ring a pass rather than the whole of it.
 *
 * ── THE HOLE ────────────────────────────────────────────────────────────────
 * `maxGapMs` is the longest wait between two consecutive folded prints, the
 * gap from the last print a previous process folded included — a restart that
 * lost twenty minutes of tape has missed whatever happened in them, and
 * `dayRobust` stops trusting the extremes. The gap BEFORE the first print is
 * not a hole: that is `dayComplete`'s business (the first fold after 09:16
 * never saw the open).
 *
 * PURE: no clock, no IO. Every instant is a field of `inputs`.
 */
import { DECISION_CLOCK_CLOSE_MIN, SESSION_OPEN_MIN } from '../../session.ts';
import type { PlaybookState } from '../../types.ts';
import type { DeltaLeanInputs } from '../decide.ts';

const MINUTE_MS = 60_000;
const IST_OFFSET_MS = 330 * MINUTE_MS;
/** One session, in minutes: 09:15 to 15:30 on the live desk's decision clock
 * (`DECISION_CLOCK_CLOSE_MIN`), not the 15:40 F&O close: `Dday` sizes stops,
 * so moving it is its own decision (session.ts). The fold window ends here
 * too; past 15:15 the cash spot is the closing auction's anyway. */
const SESSION_MINUTES = DECISION_CLOCK_CLOSE_MIN - SESSION_OPEN_MIN;
/** `Dday` freezes at the first straddle at or after 09:16 (spec §4.2). */
const DAY_IMPLIED_FROM_MIN = SESSION_OPEN_MIN + 1;
/** How far behind its resume point each fold re-reads the ring. */
const OVERLAP_MS = MINUTE_MS;
/** The longest a quiet tape goes without the resume point being written. */
const CHECKPOINT_MS = 5 * MINUTE_MS;
/** Three prints is the fewest a median-of-3 can outvote one bad one with. */
const MIN_FOLD_SAMPLES = 3;

/** The median of three numbers. */
export const median3 = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/** The median of the first three prints in `[fromMs, toMs]`, or null with
 * fewer — walked forward one print at a time with `range`. */
function openOf(ring: DeltaLeanInputs['ring'], fromMs: number, toMs: number): number | null {
  const a = ring.range(fromMs, toMs);
  const b = a === null ? null : ring.range(a.firstMs + 1, toMs);
  const c = b === null ? null : ring.range(b.firstMs + 1, toMs);
  return a === null || b === null || c === null ? null : median3(a.first, b.first, c.first);
}

/** 09:15:00 IST on `dateIst`, as epoch ms; NaN for a string that is no date. */
export function sessionOpenMs(dateIst: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIst);
  if (m === null) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS + SESSION_OPEN_MIN * MINUTE_MS;
}

/**
 * Did the fold see the open? The first folded print must be at or before
 * 09:16:00. A book that started later never saw where the day began, so the
 * rules that measure from the open (Reversal's excursion, the max-move gates)
 * do not trade it (spec O9).
 */
export function dayComplete(pb: PlaybookState, dateIst: string): boolean {
  return pb.statsFromMs > 0 && pb.statsFromMs <= sessionOpenMs(dateIst) + MINUTE_MS;
}

/**
 * Fold the ring's new prints into the day's statistics, and freeze `Dday`.
 *
 * `Dday = STR x sqrt(min(375, MTE) / MTE)` — the straddle is the move priced to
 * expiry; scaled by the square root of time it is the move priced for one
 * session. Frozen at its first reading at or after 09:16 and never again: a
 * stop sized in it must not drift with the afternoon's straddle. `str` null or
 * no time left freezes nothing, and the next pass tries again.
 *
 * Before 09:15 there is no session, and the state comes back untouched.
 */
export function foldSession(
  pb: PlaybookState,
  inputs: DeltaLeanInputs,
  minutesToExpiry: number,
  str: number | null,
): PlaybookState {
  const openMs = sessionOpenMs(inputs.dateIst);
  if (!Number.isFinite(openMs) || inputs.nowMs < openMs) return pb;
  const toMs = Math.min(inputs.nowMs, openMs + SESSION_MINUTES * MINUTE_MS);
  const fromMs = pb.statsLastMs > 0 ? Math.max(openMs, pb.statsLastMs - OVERLAP_MS) : openMs;

  let next = pb;
  const r = toMs >= fromMs ? inputs.ring.filteredRange(fromMs, toMs) : null;
  if (r !== null && r.lastMs > pb.statsLastMs && r.samples >= MIN_FOLD_SAMPLES) {
    const dayOpen = pb.dayOpen > 0 ? pb.dayOpen : (openOf(inputs.ring, fromMs, toMs) ?? r.first);
    const dayHigh = pb.dayHigh > 0 ? Math.max(pb.dayHigh, r.hi) : r.hi;
    const dayLow = pb.dayLow > 0 ? Math.min(pb.dayLow, r.lo) : r.lo;
    const statsFromMs = pb.statsFromMs > 0 ? pb.statsFromMs : r.firstMs;
    // The ring no longer holds the print the last fold ended on (a restart):
    // the wait from that print to the first one after it is a hole too.
    const lost = pb.statsLastMs > 0 && r.firstMs > pb.statsLastMs ? r.firstMs - pb.statsLastMs : 0;
    const maxGapMs = Math.max(pb.maxGapMs, r.maxGapMs, lost);
    const changed =
      dayOpen !== pb.dayOpen || dayHigh !== pb.dayHigh || dayLow !== pb.dayLow ||
      statsFromMs !== pb.statsFromMs || maxGapMs !== pb.maxGapMs;
    if (changed || r.lastMs - pb.statsLastMs >= CHECKPOINT_MS) {
      next = { ...pb, dayOpen, dayHigh, dayLow, statsFromMs, statsLastMs: r.lastMs, maxGapMs };
    }
  }

  if (
    next.dayImplied === 0 &&
    inputs.minuteOfDay >= DAY_IMPLIED_FROM_MIN &&
    str !== null && str > 0 &&
    minutesToExpiry > 0
  ) {
    next = { ...next, dayImplied: str * Math.sqrt(Math.min(SESSION_MINUTES, minutesToExpiry) / minutesToExpiry) };
  }
  return next;
}
