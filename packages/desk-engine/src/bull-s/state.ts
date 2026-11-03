/**
 * `RuleState.bs` — THE BULL-S BOOK'S OWN ROW (spec §6.3), and the one door it
 * comes back through.
 *
 * A BULL-S book sells a straddle each time its reference crosses a grid
 * level, so it carries a LIST of straddles ("groups"), each with its own entry
 * premiums and its own stop clock, plus the pyramid size, the last reference
 * price a crossing is measured from, and the halt latch. Nested in `RuleState`
 * as one object for the reason `pb` is: it is one thing, read by one path and
 * hydrated by one function, and no other decide path reads or writes it.
 *
 * Every field is REQUIRED with an explicit zero-value (`types.ts` §2). For a
 * price, a clock or a size, 0 means "none": no index prints 0 and no epoch is
 * 0. `pnlBaseline` is the exception — 0 is a real figure there — and it is
 * read only once `armedAtMs` says the book has armed.
 *
 * The straddle stores its ENTRY PREMIUMS, never a trigger price (rule 3), so a
 * Dials change to the stop multiple or its hold time reaches an open straddle
 * at the next decision.
 *
 * PURE: no clock, no IO. Imports no value from `types.ts`, which imports this.
 */

/** One straddle: a short CE and a short PE at one strike. */
export interface BullSGroup {
  readonly strike: number;
  /** Contracts per leg, as sold. */
  readonly lots: number;
  /** Per-unit sale prices — the fill once the leg is held, the quote before. */
  readonly ceEntry: number;
  readonly peEntry: number;
  readonly openedMs: number;
  /** The book holds (or has just been sent) this leg. */
  readonly ceOpen: boolean;
  readonly peOpen: boolean;
  /** When the summed exit price first stood at or past the stop. 0 = not breaching. */
  readonly breachSinceMs: number;
  /**
   * Both legs have been seen HELD at once — the straddle actually opened. Until
   * then a group is only an entry that was sent: one that ends holding nothing
   * or one leg was refused, and is undone (size) and cooled (level).
   */
  readonly filled: boolean;
}

/** A level whose last entry was refused, not to be sold again before `untilMs`. */
export interface BullSCooldown {
  readonly strike: number;
  readonly untilMs: number;
  /** Why, in words: the venue's refusal when the host recorded one. */
  readonly reason: string;
}

export type BullSHaltReason = '' | 'target' | 'loss' | 'close' | 'flat' | 'expiry';

export interface BullSState {
  readonly groups: ReadonlyArray<BullSGroup>;
  /** The NEXT straddle's contracts. 0 = not armed yet (the arm sets `bs_lots_start`). */
  readonly size: number;
  /** The reference price the next crossing is measured from. 0 = none: the next fresh price is the first. */
  readonly lastRef: number;
  /** That price's own timestamp (the feed's, not the decision's). */
  readonly lastRefMs: number;
  /** The book trades no new straddle and closes what it holds. Cleared by a re-arm. */
  readonly halted: boolean;
  readonly haltReason: BullSHaltReason;
  /** When the book last armed (Start or Re-arm). 0 = never. */
  readonly armedAtMs: number;
  /** `totalPnl` at that arm: target and loss cap read the P&L since it. */
  readonly pnlBaseline: number;
  /** The `bs_close_req` / `bs_rearm_req` counters already acted on. */
  readonly closeReqSeen: number;
  readonly rearmReqSeen: number;
  /** Levels cooling down after a refused entry (`bs_level_cooldown_s`). */
  readonly cooldowns: ReadonlyArray<BullSCooldown>;
  /**
   * The refusal the HOST read off the last entry package's outcome (skips and
   * route errors — the gateway's `oi-cap: …`, the exchange's own reason).
   * '' = none. Consumed by the pass that finds the entry failed.
   */
  readonly entryRefusal: string;
}

export const BS_EMPTY: BullSState = {
  groups: [],
  size: 0,
  lastRef: 0,
  lastRefMs: 0,
  halted: false,
  haltReason: '',
  armedAtMs: 0,
  pnlBaseline: 0,
  closeReqSeen: 0,
  rearmReqSeen: 0,
  cooldowns: [],
  entryRefusal: '',
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, fallback: number): number => (finite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function haltReason(v: unknown): BullSHaltReason {
  return v === 'target' || v === 'loss' || v === 'close' || v === 'flat' || v === 'expiry' ? v : '';
}

/**
 * A group that is not a WHOLE group is DROPPED, never zero-filled: a straddle
 * read back as `strike: 0` would close a strike that is not listed, and one
 * read as `ceEntry: 0` would stop on its first quote. Dropping is safe because
 * `decideBullS` adopts any engine leg no group accounts for, from the leg's
 * own fill — so a short is never left without a stop by a bad row.
 */
function group(v: unknown): BullSGroup[] {
  const g = obj(v);
  if (g === null) return [];
  const { strike, lots, ceEntry, peEntry, openedMs, ceOpen, peOpen, breachSinceMs } = g;
  // A row from before the field: its size already stepped at the entry, so it
  // reads as OPENED — never undone a second time.
  const filled = typeof g['filled'] === 'boolean' ? g['filled'] : true;
  if (!finite(strike) || strike <= 0 || !finite(lots) || lots <= 0) return [];
  if (!finite(ceEntry) || !finite(peEntry) || !finite(openedMs) || !finite(breachSinceMs)) return [];
  if (typeof ceOpen !== 'boolean' || typeof peOpen !== 'boolean') return [];
  if (!ceOpen && !peOpen) return [];
  // The nine fields and nothing else, in this order: `sameRuleState` is a
  // `JSON.stringify` equality.
  return [{ strike, lots, ceEntry, peEntry, openedMs, ceOpen, peOpen, breachSinceMs, filled }];
}

function cooldown(v: unknown): BullSCooldown[] {
  const c = obj(v);
  if (c === null) return [];
  const { strike, untilMs, reason } = c;
  if (!finite(strike) || strike <= 0 || !finite(untilMs)) return [];
  return [{ strike, untilMs, reason: typeof reason === 'string' ? reason : '' }];
}

/**
 * Read a stored `bs` field by field. A row from a build before BULL-S (no
 * `bs`) reads as a book that has never armed; nothing is coerced (`'1'` for a
 * size is a typo, not a size); the keys come out in `BS_EMPTY` order whatever
 * order the row stored them in.
 */
export function hydrateBullState(raw: unknown): BullSState {
  const d = obj(raw) ?? {};
  const E = BS_EMPTY;
  return {
    groups: Array.isArray(d['groups']) ? d['groups'].flatMap(group) : [],
    size: num(d['size'], E.size),
    lastRef: num(d['lastRef'], E.lastRef),
    lastRefMs: num(d['lastRefMs'], E.lastRefMs),
    halted: bool(d['halted'], E.halted),
    haltReason: haltReason(d['haltReason']),
    armedAtMs: num(d['armedAtMs'], E.armedAtMs),
    pnlBaseline: num(d['pnlBaseline'], E.pnlBaseline),
    closeReqSeen: num(d['closeReqSeen'], E.closeReqSeen),
    rearmReqSeen: num(d['rearmReqSeen'], E.rearmReqSeen),
    cooldowns: Array.isArray(d['cooldowns']) ? d['cooldowns'].flatMap(cooldown) : [],
    entryRefusal: typeof d['entryRefusal'] === 'string' ? d['entryRefusal'] : E.entryRefusal,
  };
}
