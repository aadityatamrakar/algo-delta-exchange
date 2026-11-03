/**
 * WHEN THE ENGINE IS ALLOWED TO THINK — the NSE trading calendar and the
 * 5-minute mark grid.
 *
 * Two failures this prevents, both silent:
 *
 *   1. DECIDING ON A DEAD MARKET. On a holiday or after the bell the feed
 *      still has a last book, the greeks still solve, and the corridor
 *      arithmetic still produces a number — so an ungated supervisor forms
 *      real decisions against a frozen chain and routes them at the next
 *      open, at prices nobody quoted. Nothing throws; the book just moves.
 *
 *   2. THE OPENING AUCTION. `RULES_START_MIN` is 09:20, not 09:15, because
 *      the first five minutes of an NSE session are where the pre-open
 *      carry-over and the widest spreads of the day live. This desk has
 *      already been burned by pre-open prints once — the range-breakout tags
 *      anchored their bands on a stale-close bar — and the answer there was
 *      the same: do not let a rule read the first minutes.
 *
 * ── THE CALENDAR IS A COPY, NOT A GUESS ─────────────────────────────────────
 * `MARKET_HOLIDAYS_2026` and `isTradingDay` are ported verbatim from the
 * Python desk's own gate, which is the calendar every existing board and
 * fixture was measured against:
 *
 *   `sensibull-desk/sensibull_tools/universe.py`
 *     :390-414   MARKET_HOLIDAYS — the 2026 NSE full-day equity/F&O closures,
 *                hand-maintained against the NSE circular. Holidays that fall
 *                on a weekend are deliberately absent (the weekday check
 *                already excludes them), and the ceremonial Muhurat session
 *                (2026-11-08, a Sunday) stays closed for the same reason.
 *     :417-431   is_trading_day — weekend check, then membership.
 *
 * It FAILS OPEN, also deliberately, and also copied (:423-427): a weekday of a
 * year the list does not cover is reported as a trading day. The alternative —
 * failing closed — is a supervisor that stops managing live short books on
 * 1 January without saying anything. The list has to be replaced wholesale
 * when the NSE publishes 2027; Python has `holidays_stale()` to nag about it,
 * and the supervisor's own boot log is where that belongs on this side.
 *
 * ── THE MARK GRID ───────────────────────────────────────────────────────────
 * The engine evaluates continuously off ticks (spec §7) but its rule state is
 * counted in MARKS: `confirm_marks`, `target_confirm_marks`, `anchor_ema_marks`
 * and the once-per-session EOD sweep are all "how many 5-minute marks", which
 * is the cadence the Python boards were measured at. `markOf` is the single
 * definition of which mark a minute belongs to, so those counters cannot drift
 * apart across the supervisor, the engine and a fixture replay.
 *
 * It CLAMPS rather than extrapolates. A minute before the open belongs to the
 * open's mark and a minute after the close belongs to the close's, because the
 * alternative is a mark number no session ever had — and a confirmation streak
 * that counts marks the market was shut for is a streak that fires on nothing.
 *
 * Pure: dates in, booleans and integers out. `dateIst` is already IST-resolved
 * by the caller (the supervisor owns the clock), which is why nothing here
 * touches `Date.now()` or a timezone.
 */

/** 09:15 IST as minutes since midnight — the NSE equity/F&O open. */
export const SESSION_OPEN_MIN = 555;

/*
 * ── 15:30 IS WHERE THE LIVE DESK STOPS, NOT WHERE F&O DOES ──────────────────
 * Since 3 Aug 2026 NSE F&O trades to 15:40, and 15:40 is when a contract
 * expires and stops being valued (core's `FNO_CLOSE_MIN`; the greeks package
 * prices to it). This engine still runs on 15:30, under two names, because
 * moving either one changes when a live book trades (spec 2026-10-23, G6):
 *
 *   - `DECISIONS_END_MIN`: the gates. The session gate holds past it, the
 *     expiry settle flattens expiring legs at it (at 15:40 the contracts are
 *     gone and nothing can close them), and the mark grid ends on it. Moving
 *     it would let the desk place orders from 15:30 to 15:40. From 15:15 an
 *     F&O stock's cash spot is the closing auction's, not a continuous print,
 *     and extending the order window is a separate decision.
 *   - `DECISION_CLOCK_CLOSE_MIN`: the clock the rules' inputs are measured
 *     on. That is the expiry-day tenor of the desk's own greeks
 *     (`marking.yearFrac`), the trading minutes to expiry and one session's
 *     length (the delta-lean regime bar and `Dday`). These size the live
 *     desk's entries, stops and adjusts. Measured to 15:40, every one of
 *     them moves (~1.3% on the bar and on `Dday`, more on expiry-day
 *     greeks), so they stay 15:30 until moving them is decided on its own.
 *
 * They are equal today, but they are separate decisions, so they get separate
 * names.
 */

/** 15:30 IST: the end of the live desk's decisions (its session gate, expiry
 * settle and last mark). Not the F&O close; see the note above. */
export const DECISIONS_END_MIN = 930;

/** 15:30 IST: the close the live desk's decision clock measures time to
 * (expiry-day greeks tenor, trading minutes to expiry, session length). Not
 * the F&O expiry instant (15:40); see the note above. */
export const DECISION_CLOCK_CLOSE_MIN = 930;

/** 09:20 IST — the first minute the rules may act. See the opening-auction
 * note above; the five minutes before this are marked but not traded. */
export const RULES_START_MIN = 560;

/** Minutes per decision mark. Not a dial: the Python boards every preset in
 * `presets.ts` came from were run at `--interval 5`, and the mark-counted
 * dials are calibrated for it. */
export const MARK_STEP_MIN = 5;

/**
 * NSE full-day equity/F&O trading holidays for 2026, `YYYY-MM-DD` -> name.
 * Verbatim from `universe.py:397-414`; the name is what a "market closed"
 * banner renders. Weekend-falling holidays are intentionally NOT listed.
 */
export const MARKET_HOLIDAYS_2026: Readonly<Record<string, string>> = {
  '2026-01-15': 'Special Holiday',
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali Balipratipada',
  '2026-11-24': 'Guru Nanak Jayanti',
  '2026-12-25': 'Christmas',
};

/**
 * `true` iff `dateIst` (`YYYY-MM-DD`) is an NSE trading day: not a
 * Saturday/Sunday and not in `MARKET_HOLIDAYS_2026`.
 *
 * Ported from `universe.py:417-431`, including its fail-open behaviour on a
 * year the calendar does not cover. A malformed date is NOT a trading day —
 * that is the one place this is stricter than Python, which would raise; here
 * an unparseable date means the supervisor holds rather than acts on a string
 * it does not understand.
 */
export function isTradingDay(dateIst: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIst)) return false;
  // UTC on purpose: the string is already an IST calendar date, so no offset
  // is applied to it — this is date arithmetic, not a moment in time.
  const dow = new Date(`${dateIst}T00:00:00Z`).getUTCDay(); // 0 = Sun, 6 = Sat
  if (Number.isNaN(dow)) return false; // '2026-13-45' matches the shape
  if (dow === 0 || dow === 6) return false;
  return !Object.hasOwn(MARKET_HOLIDAYS_2026, dateIst);
}

/**
 * The 5-minute mark a given IST minute-of-day belongs to, floored, and
 * CLAMPED into the session: anything before the open is the open's mark,
 * anything at or after `DECISIONS_END_MIN` (15:30) is that last mark's. See
 * the mark-grid note above for why it clamps rather than extrapolating.
 */
export function markOf(minuteOfDay: number): number {
  if (!Number.isFinite(minuteOfDay) || minuteOfDay <= SESSION_OPEN_MIN) {
    return SESSION_OPEN_MIN;
  }
  if (minuteOfDay >= DECISIONS_END_MIN) return DECISIONS_END_MIN;
  const stepsIn = Math.floor(
    (minuteOfDay - SESSION_OPEN_MIN) / MARK_STEP_MIN,
  );
  return SESSION_OPEN_MIN + stepsIn * MARK_STEP_MIN;
}

/** Whether two IST minutes fall in the same decision mark. The mark-counted
 * dials advance on a CHANGE of mark, so this is the only correct way to ask
 * "have we already decided this pass?". */
export function isSameMark(a: number, b: number): boolean {
  return markOf(a) === markOf(b);
}
