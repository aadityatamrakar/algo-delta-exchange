/**
 * `tradingDaysToExpiry` — HOW FAR AWAY A CONTRACT IS, COUNTED IN SESSIONS
 * (six-playbooks spec §4.3 step 10; `pb_min_dte`).
 *
 * Calendar days mislead exactly where the playbooks ask the question. A
 * Friday's view of a Monday weekly is three calendar days and ONE session; a
 * holiday week — NIFTY's expiry moved to Monday 19 Oct 2026 by Dussehra on the
 * 20th — shortens a contract's life without moving its date much. `pb_min_dte`
 * exists to keep the intraday books off the contract about to expire (D8) and
 * to give a short-premium book sessions of decay to sell, and both of those
 * are questions about SESSIONS.
 *
 * THE RULE: the NSE trading sessions strictly AFTER `dateIst`, up to and
 * INCLUDING `expiry`, weekends and holidays removed (`isTradingDay`). Today's
 * contract is 0, Friday's view of that Monday weekly is 1, and today itself
 * never counts — a session already under way is not one the book has left.
 *
 * -1 MEANS NOT A LIVE CONTRACT: an expiry before today, a string that is not a
 * real date, or an expiry more than `HORIZON_DAYS` away (no listed index
 * option runs that long; a date that far is a typo, and a typo must not cost a
 * loop over decades on every pass). Never 0, which is "expires today" and is
 * exactly what an expiry preset trades: a dead or unreadable contract must
 * fail every `pb_min_dte` gate, the expiry presets' 0 included, whichever way
 * round the gate is written.
 *
 * PURE: no clock. The holiday table is `session.ts`'s, so a year it does not
 * list counts weekends only (spec §11, the 2027 table).
 */
import { isTradingDay } from '../../session.ts';

/** The furthest expiry counted, in calendar days: ten years. */
const HORIZON_DAYS = 3_660;

const DAY_MS = 86_400_000;

/** Epoch ms of an ISO date at UTC midnight, or null if it is not a real day.
 * Round-tripped, because `Date.UTC` rolls '2026-02-31' over into March. */
function dayMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/** The trading sessions after `dateIst` up to and including `expiry`; -1 for a
 * contract that is not live (see the header). */
export function tradingDaysToExpiry(dateIst: string, expiry: string): number {
  const from = dayMs(dateIst);
  const to = dayMs(expiry);
  if (from === null || to === null) return -1;
  if (to < from) return -1;
  if ((to - from) / DAY_MS > HORIZON_DAYS) return -1;
  let sessions = 0;
  for (let ms = from + DAY_MS; ms <= to; ms += DAY_MS) {
    if (isTradingDay(new Date(ms).toISOString().slice(0, 10))) sessions += 1;
  }
  return sessions;
}
