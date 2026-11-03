/**
 * THE DAY ROLL — the only thing left of the v1 lean module.
 *
 * The v1 controller had a LEAN: a directional bet with an identity, its own
 * banked P&L and a high-water mark, because it added on a new peak and cut on
 * the drawdown from it. This engine has neither an add-on-profit rule nor a cut
 * rule (hold-and-adjust spec D2), so the identity, the peak, the per-lean bank
 * and the flip counters are all gone, and with them `leanPnl`, `newLeanId`,
 * `canFlip` and `rollFlipHour`.
 *
 * What survives is the auto-start. An intraday book is flat by 15:00 and lives
 * one trading day; a HOLD book (`dl_hold_to_expiry`) lives from one expiry to
 * the next and carries its package overnight. On a new IST date either must
 * forget the DAY it just had — a hold book keeps its open, side and stop, see
 * `rollDay` — and on the SAME date it must forget nothing — a mid-session restart that cleared the
 * stop, or the open, would either re-enter a book that stopped itself or lay a
 * second package on top of the first.
 *
 * PURE: no clock, no feed, no Mongo. `nowMs` and `dateIst` are arguments so a
 * fixture can replay a session that is long over.
 */
import { EMPTY_PLAYBOOK_STATE, type RuleState } from '../types.ts';

/**
 * The auto-start.
 *
 * A NEW IST date clears the stop, the open, the adjustment counters, the stuck
 * clock and the day's realised bank: the book that stopped itself yesterday
 * trades again this morning with no operator action and no restart.
 *
 * The SAME date returns the state UNCHANGED — the same object, so a caller
 * cannot accidentally persist a rewritten copy. `dlDayStarted` `''` is "never",
 * and never is not today, so a fresh row rolls on its first loop.
 *
 * `dlRegimeSinceMs` is ANCHORED at the roll rather than zeroed. A 0 would read
 * as "the regime has been this way since the epoch", so the session's very
 * first tick would satisfy `dl_adjust_confirm_s` and open on a reading the
 * detector has held for one second.
 *
 * `cumRealized` is NOT touched — it is the tag's bank, the supervisor's
 * `#settle` is its only writer, and a delta-lean tag lives one trading day
 * anyway (§6 of the runbook) — a hold book's tag lives to expiry, and its
 * `cumRealized` is the book's lifetime bank, which is what its exits read.
 * `dlDayRealized` IS zeroed: it is this day's half
 * of the same money, kept for the ledger.
 *
 * This moves STATE only, and a leg that somehow survived the night is left
 * where it is. `dlOpenedMs: 0` makes the new day open its own package ON TOP of
 * the survivor, and from that tick the survivor is part of the book like any
 * other leg: `netDeltaLots` counts it, §6.2 sizes adjustments against it, and
 * §6.5's `closeAll` takes it off at the flatten with everything else. It is
 * ADJUSTED AROUND — nothing here or in `decide.ts` singles it out, and no rule
 * closes it early.
 *
 * That is survivable rather than intended, and unreachable for an INTRADAY
 * book: its tag is per-day (`NIFTY-delta-lean-aggressive-2026-10-05`, runbook
 * §6), so tomorrow's book is a different tag with an empty leg list and
 * yesterday's row is never rolled. A HOLD book is the case where the row DOES
 * roll with legs on it, every night — which is why `hold` keeps the open.
 *
 * The recenter fields (`rcCredit`, `gkAnchor`, the scrap ban list, `rcStack`,
 * `lastActionMs` …) are untouched — one `RuleState` serves both decide paths.
 *
 * `hold` is `dials.dl_hold_to_expiry` (hold-to-expiry spec, 2026-10-05). A hold
 * book lives from the first day after one expiry to the next, so the survivor
 * case above is its ordinary night: it KEEPS `dlStopped`, `dlOpenedMs` and
 * `dlOpenSide`, and the carried package is adjusted around as the same book
 * rather than opened on top of. Everything else here still rolls by the day —
 * the adjust count, the cooldown, the churn guard's regime, the stuck clock,
 * the rupee hold's clock and the day's bank are DAY limits on a weekly book
 * too.
 *
 * `pb`, the playbook frame's row (six-playbooks spec §4.3 step 0, §4.4), goes
 * back to `EMPTY_PLAYBOOK_STATE` WHOLE on a new date, hold or not. Every field
 * in it is one session's: the open, high and low the stops are measured from,
 * the frozen day move, the day's entry count, the `doneForDay` latch and the
 * trade's own stamps. Carried into the next morning, yesterday's `dayOpen`
 * would judge today's moves from last night's level and yesterday's
 * `doneForDay` would keep the book out all day. A playbook book is flat by
 * 15:00 and its tag is per-day, so there is no trade to carry; and no hold
 * book reads `pb` at all. On the SAME date it is untouched, with the rest of
 * the row — a restart mid-trade finds the trade where it left it.
 */
export function rollDay(
  state: RuleState,
  dateIst: string,
  nowMs: number,
  hold = false,
): RuleState {
  if (dateIst === state.dlDayStarted) return state;
  return {
    ...state,
    dlDayStarted: dateIst,
    // A HOLD BOOK (`dl_hold_to_expiry`) keeps these three across the date: the
    // package is opened ONCE for the book's life, its side is what every later
    // posture is read against, and an exit is terminal until expiry. Clearing
    // `dlStopped` here would re-open a book that banked its target yesterday.
    dlStopped: hold ? state.dlStopped : false,
    dlOpenedMs: hold ? state.dlOpenedMs : 0,
    dlOpenSide: hold ? state.dlOpenSide : '',
    dlAdjustsToday: 0,
    dlLastAdjustMs: 0,
    dlLastAdjustRegime: '',
    dlBlockedSinceMs: 0,
    dlRupeeSinceMs: 0,
    dlDayRealized: 0,
    dlRegime: '',
    dlRegimeSinceMs: nowMs,
    // The playbook's day, whole — on a hold book too (see above).
    pb: EMPTY_PLAYBOOK_STATE,
  };
}
