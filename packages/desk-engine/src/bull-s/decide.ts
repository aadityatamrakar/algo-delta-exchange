/**
 * `decideBullS` — THE BULL-S DECIDE PATH (Delta spec §6), the desk's fourth.
 *
 * The book sells a straddle (PE + CE, same strike) each time its reference
 * price crosses a grid level, one size bigger than the last, and buys each
 * straddle back on its own combined stop. Venue-neutral: on Delta the
 * reference is the `.DEXBTUSD` index and sizes are contracts of 0.001 BTC; in
 * the NSE parity suite it is the future and sizes are lots.
 *
 * ── THE ORDER OF ONE DECISION ───────────────────────────────────────────────
 * Each step can end the decision; the order is the priority.
 *
 *   0. Arm on first sight: P&L baseline, size = `bs_lots_start`, and the two
 *      command counters ADOPTED as already seen (a copied row never fires a
 *      stale Close).
 *   1. At or past the expiry instant: NO ORDERS AT ALL. Settlement books the
 *      legs at the venue's price (spec §5.4) — a close sent now would race it.
 *   2. Reconcile the straddles with the book (below).
 *   3. The two commands, Re-arm then Close, so both in one pass ends closed.
 *   4. The reference: fresh or not, and what it crossed.
 *   5. The stop clocks, on the EXIT side, from each straddle's own entry.
 *   6. A halt in force: close everything (re-sent until flat), then stay flat
 *      or re-arm per `bs_after_halt`.
 *   7. The expiry flat, 8. the target and the loss cap — each a new halt.
 *   9. Stops, and any HALF straddle (one leg held) closed.
 *  10. At most one new straddle: the crossed level nearest the price.
 *
 * Steps 6-9 never wait for anything. Step 10 waits for everything: a working
 * order, a stale price, the window, the weekday, the blackout, `bs_max_open`,
 * an occupied level, an unlisted strike.
 *
 * ── STATE vs MARK STATE ─────────────────────────────────────────────────────
 * `markState` is everything this pass learned that holds whether or not its
 * actions are routed: the reconciled straddles, the reference baseline, the
 * stop clocks, the command acks and every halt latch. `stateAfter` adds the
 * one thing that is true only if the orders go: a new straddle and the size
 * step. A host holding under a working package persists `markState`, so a
 * crossing seen then is spent (an entry never goes on late) while a halt
 * survives the pre-emption.
 *
 * ── RECONCILING WITH THE BOOK ───────────────────────────────────────────────
 * The straddles are this book's own record; the legs are the truth. While no
 * order of the book is working (`pendingLots` 0), each straddle's
 * `ceOpen`/`peOpen` is set to what the book holds, a straddle holding nothing
 * is dropped (its level can be sold again on its next crossing), and an
 * engine short that no straddle accounts for is ADOPTED as one, from its own
 * fill — a lost or malformed row must never leave a short without a stop.
 * A held leg's entry is always its fill. While an order works, nothing is
 * dropped or adopted: an unfilled sale is not a missing leg.
 *
 * PURE: no clock, no IO.
 */
import type { Dials } from '../dials.ts';
import { type MarkContext, totalPnl } from '../guards.ts';
import type {
  ChainSnap,
  EngineAction,
  EngineDecision,
  EngineInputs,
  LegView,
  OptType,
  Quote,
  RuleState,
  Trigger,
} from '../types.ts';
import { bsCrossedLevel, bsCrossedListed, bsNearestLevel, bsNearestListed } from './grid.ts';
import type { BullSGroup, BullSHaltReason, BullSState } from './state.ts';
import { bsFirstSize, bsNextSize, bsSizeAfter, bsSizeKey, leverageAt, quoteMark, shortOptionMargin, type MarginMode, type StrikeLeverage } from './margin.ts';

/**
 * What BULL-S needs beyond an ordinary `EngineInputs`. All three REQUIRED: an
 * absent reading and a zero one must never be the same read.
 *
 *   - `ref` is the reference price the grid is crossed on (DX: the
 *     `.DEXBTUSD` index; NSE parity: the future). null = no price yet.
 *   - `refAsOf` is that price's own epoch ms, off the feed. 0 = never, which
 *     reads as stale.
 *   - `minutesToExpiry` runs to the venue's expiry instant (DX: 12:00 UTC).
 *     At or below 0 the book sends nothing.
 */
export interface BullSInputs extends EngineInputs {
  readonly ref: number | null;
  readonly refAsOf: number;
  readonly minutesToExpiry: number;
  /**
   * Each listed strike's leverage per wing (Delta's `default_leverage`, the
   * instrument row's `dx_leverage`), for the `bs_margin_budget` estimate.
   * A wing the master states none for is null; [] on a venue with none.
   */
  readonly leverage: ReadonlyArray<StrikeLeverage>;
  /**
   * The account's margin mode (`margin.ts`), for the same estimate. Absent or
   * null = unknown, priced as ISOLATED — the larger figure.
   */
  readonly marginMode?: MarginMode | null;
}

/**
 * How long a book's OWN entry may sit with one wing filled and the other still
 * working before the filled wing is closed as a half straddle anyway. Long
 * enough for an ordinary two-leg fill; short enough that a stuck order on one
 * wing never leaves the other naked for minutes. The close is a BS exit, so
 * the host cancels the stuck order first (`BS_EXIT_TRIGGERS`).
 */
export const BS_HALF_ENTRY_GRACE_MS = 30_000;

/** Strike equality, the tolerance `marking.ts` matches a chain row on. */
const STRIKE_EPS = 1e-6;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const HALT_TRIGGER: Readonly<Record<Exclude<BullSHaltReason, ''>, Trigger>> = {
  target: 'bs-target',
  loss: 'bs-loss',
  close: 'bs-close',
  flat: 'bs-flat',
  expiry: 'bs-expiry',
};

const HALT_WORDS: Readonly<Record<Exclude<BullSHaltReason, ''>, string>> = {
  target: 'the target was made',
  loss: 'the loss cap was hit',
  close: 'the operator closed the book',
  flat: 'flat before expiry',
  expiry: 'expired',
};

/** A price or an amount, as a person reads it: whole numbers bare, else two places. */
const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));

const hhmm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const sameStrike = (a: number, b: number): boolean => Math.abs(a - b) < STRIKE_EPS;

const withBs = (state: RuleState, bs: BullSState): RuleState => ({ ...state, bs });

function hold(reason: string, st: RuleState, trigger: Trigger = 'none'): EngineDecision {
  return {
    action: 'hold',
    trigger,
    reason,
    actions: [],
    stateAfter: st,
    markState: st,
    urgency: 'passive',
    makerQuote: false,
    creditCommit: null,
  };
}

function acted(
  action: 'adjust' | 'flatten',
  trigger: Trigger,
  reason: string,
  actions: readonly EngineAction[],
  stateAfter: RuleState,
  markState: RuleState,
): EngineDecision {
  // Urgent on every path: spec §6.1 rule 9 prices every order as a marketable
  // limit through the mark. `makerQuote` is the shed tier's gate; never asked.
  return { action, trigger, reason, actions, stateAfter, markState, urgency: 'urgent', makerQuote: false, creditCommit: null };
}

const withNotes = (reason: string, notes: readonly string[]): string =>
  notes.length === 0 ? reason : `${reason}; ${notes.join('; ')}`;

/** A short option leg of this book at `strike`/`opt`, if the book holds one. */
function heldLeg(legs: readonly LegView[], strike: number, opt: OptType): LegView | undefined {
  return legs.find(
    (l) => l.kind !== 'future' && l.side === 'Sell' && l.optType === opt && sameStrike(l.strike, strike) && l.lots > 0,
  );
}

function quoteOf(chain: ChainSnap, strike: number, opt: OptType): Quote | null {
  const row = chain.strikes.find((s) => sameStrike(s.strike, strike));
  if (row === undefined) return null;
  return (opt === 'CE' ? row.ce : row.pe) ?? null;
}

/** What a buy-back is priced at: the ask (basis 1) or the last price (basis 0). Zero is no price. */
function exitPx(q: Quote | null, basis: number): number | null {
  const v = q === null ? null : basis === 0 ? q.ltp : q.ask;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/** What a sale is priced at: the bid (basis 1) or the last price (basis 0). */
function entryPx(q: Quote | null, basis: number): number | null {
  const v = q === null ? null : basis === 0 ? q.ltp : q.bid;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/** The stop line, recomputed every decision from the stored entries and the LIVE dials (rule 3). */
function stopLine(g: BullSGroup, dials: Dials): number {
  const raw = (g.ceEntry + g.peEntry) * dials.bs_stop_mult;
  // Basis 0 is the legacy book's: `parseInt((ce + pe) * mult)`.
  return dials.bs_stop_basis === 0 ? Math.trunc(raw) : raw;
}

const firstSize = bsFirstSize;
const nextSize = bsNextSize;

/** Start or Re-arm: a new P&L baseline, size back to start, the halt cleared. */
function arm(bs: BullSState, inputs: BullSInputs, dials: Dials, lastRef: number, lastRefMs: number): BullSState {
  return {
    ...bs,
    size: firstSize(dials),
    sizedBy: bsSizeKey(dials),
    lastRef,
    lastRefMs,
    halted: false,
    haltReason: '',
    armedAtMs: inputs.nowMs,
    pnlBaseline: totalPnl(inputs),
  };
}

/** An entry that never opened: what was held of it when the book settled. */
interface FailedEntry {
  readonly group: BullSGroup;
  /** The one wing that filled, or '' when nothing did. */
  readonly held: '' | OptType;
}

function reconcile(
  groups: readonly BullSGroup[],
  inputs: BullSInputs,
): { groups: BullSGroup[]; failed: FailedEntry[] } {
  const { legs } = inputs;
  const settled = inputs.pendingLots === 0;
  const out: BullSGroup[] = [];
  const failed: FailedEntry[] = [];
  for (const g of groups) {
    const ce = heldLeg(legs, g.strike, 'CE');
    const pe = heldLeg(legs, g.strike, 'PE');
    // A sent entry that the settled book shows WHOLE has opened; one that
    // shows nothing or one wing was refused (the venue's cap, a rejected
    // leg) — the one fact the size step and the level cooldown turn on.
    const both = ce !== undefined && pe !== undefined;
    if (settled && !g.filled && !both) {
      failed.push({ group: g, held: ce !== undefined ? 'CE' : pe !== undefined ? 'PE' : '' });
    }
    const next: BullSGroup = {
      ...g,
      ceEntry: ce?.entry ?? g.ceEntry,
      peEntry: pe?.entry ?? g.peEntry,
      ceOpen: settled ? ce !== undefined : g.ceOpen,
      peOpen: settled ? pe !== undefined : g.peOpen,
      filled: g.filled || (settled && both),
    };
    if (next.ceOpen || next.peOpen) out.push(next);
  }
  if (!settled) return { groups: out, failed };
  // Adopt every engine short no straddle accounts for, one straddle per strike.
  const orphans = legs.filter(
    (l) =>
      l.kind !== 'future' &&
      l.side === 'Sell' &&
      l.openedByEngine &&
      l.lots > 0 &&
      !out.some((g) => sameStrike(g.strike, l.strike)),
  );
  const strikes = [...new Set(orphans.map((l) => l.strike))].sort((a, b) => a - b);
  for (const strike of strikes) {
    const ce = heldLeg(legs, strike, 'CE');
    const pe = heldLeg(legs, strike, 'PE');
    out.push({
      strike,
      lots: Math.max(ce?.lots ?? 0, pe?.lots ?? 0),
      ceEntry: ce?.entry ?? 0,
      peEntry: pe?.entry ?? 0,
      openedMs: inputs.nowMs,
      ceOpen: ce !== undefined,
      peOpen: pe !== undefined,
      breachSinceMs: 0,
      // An adopted short was sold by this book at some point; only a whole
      // straddle counts as one that opened.
      filled: ce !== undefined && pe !== undefined,
      staleSinceMs: 0,
    });
  }
  return { groups: out, failed };
}

/** Buy back one straddle's held legs, PE then CE (rule 9). */
function closeGroup(g: BullSGroup, legs: readonly LegView[]): EngineAction[] {
  return (['PE', 'CE'] as const).flatMap((opt): EngineAction[] => {
    const leg = heldLeg(legs, g.strike, opt);
    return leg === undefined ? [] : [{ op: 'close', instrument: leg.instrument }];
  });
}

/** Close the whole book: each straddle PE then CE, oldest first, then any other leg. */
function closeEverything(groups: readonly BullSGroup[], legs: readonly LegView[]): EngineAction[] {
  const ordered = [...groups].sort((a, b) => a.openedMs - b.openedMs);
  const actions = ordered.flatMap((g) => closeGroup(g, legs));
  const named = new Set(actions.map((a) => (a.op === 'close' ? a.instrument : '')));
  for (const l of legs) if (!named.has(l.instrument)) actions.push({ op: 'close', instrument: l.instrument });
  return actions;
}

function inWindow(minute: number, dials: Dials): boolean {
  const from = dials.bs_entry_from_min;
  const to = dials.bs_entry_to_min;
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** IST weekday of an ISO date, 0 = Sunday. */
const weekday = (dateIst: string): number => new Date(`${dateIst}T00:00:00Z`).getUTCDay();

export function decideBullS(
  inputs: BullSInputs,
  dials: Dials,
  state: RuleState,
  markCtx: MarkContext,
): EngineDecision {
  void markCtx;
  const { nowMs, legs, chain } = inputs;

  if (!dials.bs_enabled) return hold('BULL-S is off (bs_enabled is false)', state);
  // THE GRID: multiples of jump × step, or (`bs_grid_listed`) the strikes the
  // exchange lists for this expiry — the chain's own rows, quoted or not.
  const ladder = dials.bs_grid_listed ? [...new Set(chain.strikes.map((s) => s.strike))].filter((k) => k > 0) : null;
  if (ladder !== null && ladder.length === 0) {
    return hold('no grid: bs_grid_listed is on but the chain lists no strikes for this expiry', state);
  }
  if (ladder === null && !(dials.bs_strike_step > 0)) {
    return hold('no grid: bs_strike_step is 0 — set one strike, in price units, for this expiry', state);
  }
  const grid = dials.bs_strike_jump * dials.bs_strike_step;
  const gridWord = ladder !== null ? 'listed strikes' : fmt(grid);
  const nearestLevel = (r: number): number | null => (ladder !== null ? bsNearestListed(r, ladder) : bsNearestLevel(r, grid));
  const crossedLevel = (p: number, r: number): number | null =>
    ladder !== null ? bsCrossedListed(p, r, ladder) : bsCrossedLevel(p, r, grid);
  const maxAgeMs = dials.bs_ref_max_age_s * 1_000;
  const basis = dials.bs_stop_basis;
  const notes: string[] = [];

  // ── 0. arm on first sight ────────────────────────────────────────────────
  let bs = state.bs;
  if (bs.armedAtMs === 0) {
    bs = { ...arm(bs, inputs, dials, 0, 0), closeReqSeen: dials.bs_close_req, rearmReqSeen: dials.bs_rearm_req };
  }

  // ── 1. the expiry instant ────────────────────────────────────────────────
  if (!(inputs.minutesToExpiry > 0)) {
    return hold(
      `at or past the expiry instant: no orders — settlement books the ${legs.length} open leg(s) at the venue's settlement price`,
      withBs(state, { ...bs, halted: true, haltReason: 'expiry' }),
      'bs-expiry',
    );
  }

  // ── 2. reconcile with the book ───────────────────────────────────────────
  const rec = reconcile(bs.groups, inputs);
  bs = { ...bs, groups: rec.groups, cooldowns: bs.cooldowns.filter((c) => c.untilMs > nowMs) };

  // ── 2b. an entry the venue refused ──────────────────────────────────────
  // The size stepped when the entry was sent; it steps only for a straddle
  // that OPENED, so a refused one is undone to the size it was sold at. Its
  // level cools down `bs_level_cooldown_s` (once — a half closed later is the
  // same refusal), and the host's recorded reason is named and consumed.
  for (const f of rec.failed) {
    const cdS = dials.bs_level_cooldown_s;
    const refusal = bs.entryRefusal;
    const what =
      f.held === ''
        ? refusal !== '' ? refusal : 'nothing filled'
        : `only the ${f.held} filled${refusal !== '' ? `; ${refusal}` : ''}`;
    const cooling = bs.cooldowns.some((c) => sameStrike(c.strike, f.group.strike));
    bs = {
      ...bs,
      size: f.group.lots,
      entryRefusal: '',
      cooldowns:
        cdS > 0 && !cooling
          ? [...bs.cooldowns, { strike: f.group.strike, untilMs: nowMs + cdS * 1_000, reason: what }]
          : bs.cooldowns,
    };
    if (!cooling) {
      notes.push(
        `entry at ${fmt(f.group.strike)} was refused (${what}): size stays ${f.group.lots}` +
          (cdS > 0 ? `, level cools down ${fmt(cdS)}s` : ''),
      );
    }
  }
  // Every level still cooling is said on EVERY decision until it clears, so
  // the book's last-decision line names the refusal for as long as it holds —
  // not only on the one pass that found it. (One just found is said above.)
  const foundNow = new Set(rec.failed.map((f) => f.group.strike));
  const coolNote = (c: { strike: number; untilMs: number; reason: string }): string =>
    `level ${fmt(c.strike)} cooling down after a refused entry (${c.reason}) — ` +
    `${Math.ceil((c.untilMs - nowMs) / 1_000)}s left`;
  for (const c of bs.cooldowns) if (!foundNow.has(c.strike)) notes.push(coolNote(c));

  // ── 2c. the lot dials retuned ───────────────────────────────────────────
  // The next size was stepped under the OLD start/step/cap; carried as-is it
  // would keep the old pyramid (a book retuned from 20-lot steps to 10 would
  // still sell 45 next). Re-derived from the new dials for the straddles held:
  // start, then one step per held straddle, never past the cap.
  const sizeKey = bsSizeKey(dials);
  if (bs.size > 0 && bs.sizedBy !== sizeKey) {
    if (bs.sizedBy === '') {
      bs = { ...bs, sizedBy: sizeKey };
    } else {
      const was = bs.size;
      const size = bsSizeAfter(bs.groups.length, dials);
      bs = { ...bs, size, sizedBy: sizeKey };
      if (size !== was) {
        notes.push(
          `lot dials retuned to start/step/cap ${sizeKey}: next size ${was} → ${size} ` +
            `for the ${bs.groups.length} straddle(s) held`,
        );
      }
    }
  }

  // ── 3. the commands — Re-arm first, so a Close in the same pass wins ─────
  if (dials.bs_rearm_req > bs.rearmReqSeen) {
    if (!bs.halted) {
      bs = { ...bs, rearmReqSeen: dials.bs_rearm_req };
      notes.push('Re-arm ignored: the book is not halted');
    } else if (legs.length > 0) {
      // NOT acknowledged: it applies once the halt's closes are done.
      notes.push(`Re-arm waits: ${legs.length} leg(s) still to close`);
    } else {
      // lastRef 0: the first fresh price is a start, so `bs_enter_on_start` applies.
      bs = { ...arm(bs, inputs, dials, 0, 0), groups: [], rearmReqSeen: dials.bs_rearm_req };
      notes.push(`re-armed by the operator: P&L baseline ${fmt(bs.pnlBaseline)}, size back to ${bs.size}`);
    }
  }
  if (dials.bs_close_req > bs.closeReqSeen) {
    bs = { ...bs, closeReqSeen: dials.bs_close_req, halted: true, haltReason: 'close' };
  }

  // ── 4. the reference ─────────────────────────────────────────────────────
  const ref = inputs.ref;
  const fresh =
    ref !== null && Number.isFinite(ref) && ref > 0 && inputs.refAsOf > 0 && nowMs - inputs.refAsOf <= maxAgeMs;
  let crossed: number | null = null;
  let crossing = '';
  // The reference the crossing is measured FROM, before this pass moves it —
  // kept so an entry that is only waiting for a quote can leave it unspent.
  const priorRef = bs.lastRef;
  if (fresh) {
    if (bs.lastRef === 0) {
      if (dials.bs_enter_on_start) {
        crossed = nearestLevel(ref);
        if (crossed !== null) crossing = `first price ${fmt(ref)} after the arm: the nearest level, ${fmt(crossed)}`;
      } else {
        notes.push(`first price ${fmt(ref)} after the arm: a baseline (bs_enter_on_start is off)`);
      }
    } else if (inputs.refAsOf - bs.lastRefMs > maxAgeMs) {
      // A gap (feed loss, reconnect, restart): whatever happened in it is not
      // a crossing this book saw. Baseline, and count from here.
      const gapS = Math.round((inputs.refAsOf - bs.lastRefMs) / 1_000);
      notes.push(`fresh price ${fmt(ref)} after a ${gapS}s gap: re-baselined, no crossing counted`);
    } else {
      crossed = crossedLevel(bs.lastRef, ref);
      if (crossed !== null) crossing = `${fmt(crossed)} crossed (${fmt(bs.lastRef)} → ${fmt(ref)})`;
    }
    bs = { ...bs, lastRef: ref, lastRefMs: inputs.refAsOf };
  }

  // ── 5. the stale-quote clocks and the stop clocks ───────────────────────
  // A FROZEN QUOTE LOOKS CALM. A held leg whose quote is older than
  // `bs_quote_max_age_s` (its book frame's own `asOf`), or that has no quote
  // at all, is stale: the straddle is never read as safe off it (the breach
  // clock is not reset), no new straddle goes on while it lasts (step 10),
  // and past `bs_stale_exit_s` the straddle is bought back whole (step 9).
  const priceWord = basis === 0 ? 'last price' : 'ask';
  const quoteMaxMs = dials.bs_quote_max_age_s * 1_000;
  const staleOf = (g: BullSGroup): { since: number; words: string[] } | null => {
    let since = 0;
    const words: string[] = [];
    for (const opt of ['CE', 'PE'] as const) {
      if (!(opt === 'CE' ? g.ceOpen : g.peOpen)) continue;
      const quote = quoteOf(chain, g.strike, opt);
      const name = `${fmt(g.strike)}${opt}`;
      let at: number;
      if (quote === null || !(Number.isFinite(quote.asOf) && quote.asOf > 0)) {
        words.push(`${name} has no quote`);
        at = nowMs;
      } else if (nowMs - quote.asOf > quoteMaxMs) {
        words.push(`${name} quote ${fmt(Math.round((nowMs - quote.asOf) / 1_000))}s old`);
        at = quote.asOf + quoteMaxMs;
      } else {
        continue;
      }
      since = since === 0 ? at : Math.min(since, at);
    }
    return words.length === 0 ? null : { since, words };
  };
  bs = {
    ...bs,
    groups: bs.groups.map((g0): BullSGroup => {
      const st = staleOf(g0);
      const staleSinceMs = st === null ? 0 : g0.staleSinceMs > 0 ? Math.min(g0.staleSinceMs, st.since) : st.since;
      const g: BullSGroup = { ...g0, staleSinceMs };
      if (st !== null) {
        notes.push(
          `quote stale at ${fmt(g.strike)}: ${st.words.join(', ')} (max ${fmt(dials.bs_quote_max_age_s)}s), ` +
            `stale ${fmt(Math.round((nowMs - staleSinceMs) / 1_000))}s` +
            (dials.bs_stale_exit_s > 0 ? ` of ${fmt(dials.bs_stale_exit_s)}s before it is closed` : ''),
        );
      }
      if (!g.ceOpen || !g.peOpen) return g; // a half straddle is closed in step 9
      const ce = exitPx(quoteOf(chain, g.strike, 'CE'), basis);
      const pe = exitPx(quoteOf(chain, g.strike, 'PE'), basis);
      if (ce === null || pe === null) {
        // Neither safe nor stoppable: the clock is left exactly where it was.
        const missing = [ce === null ? 'CE' : '', pe === null ? 'PE' : ''].filter((x) => x !== '');
        notes.push(
          `stop at ${fmt(g.strike)} held — no ${priceWord} on ${missing.map((o) => `${fmt(g.strike)}${o}`).join(' or ')}, ` +
            'so the straddle can be neither priced safe nor bought back',
        );
        return g;
      }
      if (ce + pe >= stopLine(g, dials)) return { ...g, breachSinceMs: g.breachSinceMs > 0 ? g.breachSinceMs : nowMs };
      // Under the line on a STALE reading is not known to be safe: the clock stays.
      if (st !== null) return g;
      return { ...g, breachSinceMs: 0 };
    }),
  };
  const mark = withBs(state, bs);

  /** A straddle's confirmed stop, in words, or null when it does not fire this pass. */
  const stopFires = (g: BullSGroup): string | null => {
    if (!g.ceOpen || !g.peOpen || g.breachSinceMs === 0) return null;
    const heldS = (nowMs - g.breachSinceMs) / 1_000;
    if (heldS < dials.bs_stop_confirm_s) return null;
    // A clock confirmed earlier is not a price NOW: with a side unpriced the
    // stop holds (step 5 said so) and fires on the first reading that has both.
    const ceX = exitPx(quoteOf(chain, g.strike, 'CE'), basis);
    const peX = exitPx(quoteOf(chain, g.strike, 'PE'), basis);
    if (ceX === null || peX === null) return null;
    return (
      `stop at ${fmt(g.strike)}: ${priceWord}s ${fmt(ceX + peX)} ≥ ${fmt(dials.bs_stop_mult)} × entry ${fmt(g.ceEntry + g.peEntry)} ` +
      `= ${fmt(stopLine(g, dials))}, held ${fmt(Math.round(heldS * 10) / 10)}s`
    );
  };

  // A halt: close everything that is left, latched on BOTH states.
  const halt = (reason: Exclude<BullSHaltReason, ''>, why: string): EngineDecision => {
    const st = withBs(state, { ...bs, halted: true, haltReason: reason });
    if (legs.length === 0) return hold(withNotes(`${why} — flat; halted`, notes), st, HALT_TRIGGER[reason]);
    return acted(
      'flatten',
      HALT_TRIGGER[reason],
      withNotes(`${why} — closing all ${legs.length} leg(s) and halting`, notes),
      closeEverything(bs.groups, legs),
      st,
      st,
    );
  };

  // ── 6. a halt in force ───────────────────────────────────────────────────
  if (bs.halted) {
    const reason = bs.haltReason === '' ? 'close' : bs.haltReason;
    if (legs.length > 0) return halt(reason, `halted: ${HALT_WORDS[reason]}`);
    if (dials.bs_after_halt === 1 && (reason === 'target' || reason === 'loss')) {
      // The current price is the baseline: trade from the NEXT crossing.
      const re: BullSState = { ...arm(bs, inputs, dials, bs.lastRef, bs.lastRefMs), groups: [] };
      return hold(
        withNotes(
          `${HALT_WORDS[reason]} and the book is flat: re-armed by bs_after_halt — P&L baseline ${fmt(re.pnlBaseline)}, ` +
            `size back to ${re.size}, trading from the next crossing`,
          notes,
        ),
        withBs(state, re),
        'bs-rearm',
      );
    }
    return hold(withNotes(`halted: ${HALT_WORDS[reason]}; flat — Re-arm to trade again`, notes), mark);
  }

  // ── 7. flat before expiry ────────────────────────────────────────────────
  if (dials.bs_flat_before_expiry_min > 0 && inputs.minutesToExpiry <= dials.bs_flat_before_expiry_min) {
    return halt(
      'flat',
      `${fmt(inputs.minutesToExpiry)} min to expiry is inside bs_flat_before_expiry_min ${fmt(dials.bs_flat_before_expiry_min)}`,
    );
  }

  // ── 8. target and loss cap, on the P&L since the arm ────────────────────
  const pnl = totalPnl(inputs) - bs.pnlBaseline;
  if (dials.bs_target > 0 && pnl >= dials.bs_target) {
    return halt('target', `target: P&L ${fmt(pnl)} since the arm, at or past ${fmt(dials.bs_target)}`);
  }
  if (dials.bs_loss_cap > 0 && pnl <= -dials.bs_loss_cap) {
    return halt('loss', `loss cap: P&L ${fmt(pnl)} since the arm, at or below -${fmt(dials.bs_loss_cap)}`);
  }

  // ── 9. half straddles, stale exits, stops, and unbalanced straddles ─────
  // One decision carries one trigger: a stale exit outranks a stop (it is the
  // one the operator must hear about), a stop or a half close outranks a
  // balance. Every action of the pass goes out together, oldest straddle first.
  const settled = inputs.pendingLots === 0;
  const closes: EngineAction[] = [];
  const why: string[] = [];
  let anyStale = false;
  let anyStop = false;
  for (const g of [...bs.groups].sort((a, b) => a.openedMs - b.openedMs)) {
    const ceH = heldLeg(legs, g.strike, 'CE');
    const peH = heldLeg(legs, g.strike, 'PE');
    // A HALF STRADDLE NEVER WAITS ON AN UNRELATED ORDER. Settled, the
    // reconciled flags say it. While an order of the book works, the legs
    // say it: a straddle that OPENED has no order of its own to wait for (its
    // only orders are closes, which a close re-sent here joins), and the
    // book's own entry gets `BS_HALF_ENTRY_GRACE_MS` to fill its other wing.
    const half = settled
      ? g.ceOpen !== g.peOpen
      : (ceH !== undefined) !== (peH !== undefined) && (g.filled || nowMs - g.openedMs >= BS_HALF_ENTRY_GRACE_MS);
    if (half) {
      const kept = (settled ? g.ceOpen : ceH !== undefined) ? 'CE' : 'PE';
      closes.push(...closeGroup(g, legs));
      anyStop = true;
      why.push(
        `half straddle at ${fmt(g.strike)}: only the ${kept} is held — closing it rather than leave it naked` +
          (settled ? '' : ' (not waiting on the working order)'),
      );
      continue;
    }
    if (!g.ceOpen || !g.peOpen) continue;
    if (dials.bs_stale_exit_s > 0 && g.staleSinceMs > 0 && nowMs - g.staleSinceMs >= dials.bs_stale_exit_s * 1_000) {
      closes.push(...closeGroup(g, legs));
      anyStale = true;
      why.push(
        `stale exit at ${fmt(g.strike)}: a held leg's quote has been stale ${fmt(Math.round((nowMs - g.staleSinceMs) / 1_000))}s, ` +
          `past bs_stale_exit_s ${fmt(dials.bs_stale_exit_s)}s — buying the straddle back`,
      );
      continue;
    }
    const stop = stopFires(g);
    if (stop !== null) {
      closes.push(...closeGroup(g, legs));
      anyStop = true;
      why.push(stop);
      continue;
    }
    // A TRUE STRADDLE, never a lopsided one: with nothing working, a CE and PE
    // of different sizes has the excess on the LARGER leg bought back. The
    // smaller is never added to — that would be new risk on a book in doubt.
    if (settled && ceH !== undefined && peH !== undefined && ceH.lots !== peH.lots) {
      const [big, small] = ceH.lots > peH.lots ? [ceH, peH] : [peH, ceH];
      closes.push({ op: 'resize', instrument: big.instrument, targetLots: small.lots });
      why.push(
        `leg mismatch at ${fmt(g.strike)}: CE ${fmt(ceH.lots)} vs PE ${fmt(peH.lots)} — buying back ` +
          `${fmt(big.lots - small.lots)} of the ${big.optType} so the book holds a true straddle of ${fmt(small.lots)}`,
      );
    }
  }
  if (closes.length > 0) {
    const trigger: Trigger = anyStale ? 'bs-stale' : anyStop ? 'bs-stop' : 'bs-balance';
    return acted('adjust', trigger, withNotes(why.join('; '), notes), closes, mark, mark);
  }

  // ── 10. at most one new straddle ─────────────────────────────────────────
  if (inputs.pendingLots > 0) {
    return hold(withNotes('an order of this book is still working: no new straddle', notes), mark);
  }
  const staleAt = bs.groups.filter((g) => g.staleSinceMs > 0).map((g) => fmt(g.strike));
  if (staleAt.length > 0) {
    return hold(
      withNotes(`a held leg's quote is stale (${staleAt.join(', ')}): no new straddle or pyramid step until it is fresh`, notes),
      mark,
    );
  }
  if (!fresh) {
    const what =
      ref === null || !(ref > 0) || inputs.refAsOf === 0
        ? 'no reference price'
        : `the reference price is ${fmt(Math.round((nowMs - inputs.refAsOf) / 1_000))}s old (max ${fmt(dials.bs_ref_max_age_s)}s): stale`;
    return hold(withNotes(`${what} — no entry and no crossing counted; stops still run`, notes), mark);
  }
  if (crossed === null) {
    return hold(withNotes(`no grid level crossed (price ${fmt(ref)}, grid ${gridWord})`, notes), mark);
  }
  const level = crossed;
  const refuse = (but: string): EngineDecision => hold(withNotes(`${crossing}, but ${but}`, notes), mark);
  if (!inWindow(inputs.minuteOfDay, dials)) {
    return refuse(
      `${hhmm(inputs.minuteOfDay)} IST is outside the entry window ` +
        `${hhmm(dials.bs_entry_from_min)}–${hhmm(dials.bs_entry_to_min)}`,
    );
  }
  const day = weekday(inputs.dateIst);
  if ((dials.bs_entry_weekdays & (1 << day)) === 0) {
    return refuse(`${WEEKDAYS[day] ?? inputs.dateIst} is off in bs_entry_weekdays`);
  }
  if (dials.bs_no_entry_before_expiry_min > 0 && inputs.minutesToExpiry <= dials.bs_no_entry_before_expiry_min) {
    return refuse(
      `${fmt(inputs.minutesToExpiry)} min to expiry is inside the ${fmt(dials.bs_no_entry_before_expiry_min)}-min entry blackout`,
    );
  }
  if (dials.bs_max_open > 0 && bs.groups.length >= dials.bs_max_open) {
    return refuse(`${bs.groups.length} open straddles is bs_max_open`);
  }
  if (bs.groups.some((g) => sameStrike(g.strike, level))) {
    return refuse(`${fmt(level)} already holds a straddle`);
  }
  const cool = bs.cooldowns.find((c) => sameStrike(c.strike, level));
  if (cool !== undefined) {
    // Said once, as the reason this crossing was not sold.
    const said = notes.indexOf(coolNote(cool));
    if (said >= 0) notes.splice(said, 1);
    return refuse(coolNote(cool));
  }
  /**
   * UNLISTED IS A FACT, UNQUOTED IS A MOMENT. A level the chain does not list
   * at all is skipped and the crossing is spent (never substituted). A level it
   * DOES list whose CE or PE has no quote — or no price to sell at — yet is the
   * feed not having spoken: the book has just started, a quote is in flight. A
   * spent crossing there loses the entry for good (3 Nov, six books' first
   * price landed 2 s after start, before a single tick on the level). So it
   * WAITS: the reference the crossing is measured from is left where it was
   * (the start stays a start), its clock moves on so no gap is read, and the
   * next pass with both prices sells it.
   */
  const listed = chain.strikes.some((r) => sameStrike(r.strike, level));
  const waiting = (what: string): EngineDecision =>
    hold(
      withNotes(`${crossing}, but ${what} — waiting for it, the crossing is not spent`, notes),
      withBs(state, { ...bs, lastRef: priorRef }),
    );
  const ceQ = quoteOf(chain, level, 'CE');
  const peQ = quoteOf(chain, level, 'PE');
  if (!listed) {
    return refuse(`${fmt(level)} is not listed with both a CE and a PE for this expiry — skipped, never substituted`);
  }
  if (ceQ === null || peQ === null) {
    return waiting(`${fmt(level)} has no ${ceQ === null ? 'CE' : 'PE'} quote yet`);
  }
  const ceIn = entryPx(ceQ, basis);
  const peIn = entryPx(peQ, basis);
  if (ceIn === null || peIn === null) {
    const side = basis === 0 ? 'last price' : 'bid';
    return waiting(`${fmt(level)} has no ${side} to sell the ${ceIn === null ? 'CE' : 'PE'} at yet`);
  }

  const size = bs.size > 0 ? bs.size : firstSize(dials);
  if (dials.bs_margin_budget > 0) {
    const est = marginWithEntry(inputs, level, size, ceQ, peQ);
    if ('missing' in est) return refuse(`margin budget: ${est.missing} — cannot estimate, no entry`);
    if (est.usd > dials.bs_margin_budget) {
      return refuse(
        `margin budget: est $${est.usd.toFixed(2)} > $${fmt(dials.bs_margin_budget)} ` +
          `(held $${est.held.toFixed(2)} + this straddle $${est.entry.toFixed(2)})`,
      );
    }
  }
  const group: BullSGroup = {
    strike: level,
    lots: size,
    ceEntry: ceIn,
    peEntry: peIn,
    openedMs: nowMs,
    ceOpen: true,
    peOpen: true,
    breachSinceMs: 0,
    filled: false,
    staleSinceMs: 0,
  };
  const next = nextSize(size, dials);
  const after = withBs(state, { ...bs, groups: [...bs.groups, group], size: next });
  return acted(
    'adjust',
    'bs-entry',
    withNotes(
      `${crossing}: selling the ${fmt(level)} straddle, ${size} contracts, for ${fmt(ceIn + peIn)} ` +
        `(stop ${fmt(stopLine(group, dials))}; next size ${next})`,
      notes,
    ),
    [
      { op: 'open', strike: level, optType: 'PE', side: 'Sell', lots: size },
      { op: 'open', strike: level, optType: 'CE', side: 'Sell', lots: size },
    ],
    after,
    mark,
  );
}

/**
 * THE BOOK'S ESTIMATED MARGIN WITH ONE MORE STRADDLE (`bs_margin_budget`):
 * every short option it holds at its own mark, plus the new straddle at the
 * level's marks, all against the reference index and each product's own
 * leverage (`margin.ts`). A missing mark or leverage is NAMED, never guessed.
 */
function marginWithEntry(
  inputs: BullSInputs,
  level: number,
  size: number,
  ceQ: Quote,
  peQ: Quote,
): { usd: number; held: number; entry: number } | { missing: string } {
  const index = inputs.ref as number;
  const mode = inputs.marginMode ?? null;
  let held = 0;
  for (const l of inputs.legs) {
    if (l.kind === 'future' || l.side !== 'Sell' || !(l.lots > 0)) continue;
    const mark = quoteMark(l.exit);
    const lev = leverageAt(inputs.leverage, l.strike, l.optType);
    if (lev === null) return { missing: `no leverage for the ${fmt(l.strike)} ${l.optType}` };
    if (mark === null) return { missing: `no mark for the held ${fmt(l.strike)} ${l.optType}` };
    held += shortOptionMargin({ mark, qty: l.lots * l.lotSize, index, leverage: lev, mode });
  }
  let entry = 0;
  const qty = size * inputs.chain.lotSize;
  for (const [opt, q] of [['CE', ceQ], ['PE', peQ]] as const) {
    const lev = leverageAt(inputs.leverage, level, opt);
    if (lev === null) return { missing: `no leverage for the ${fmt(level)} ${opt}` };
    const mark = quoteMark(q);
    if (mark === null) return { missing: `no mark for the ${fmt(level)} ${opt}` };
    entry += shortOptionMargin({ mark, qty, index, leverage: lev, mode });
  }
  return { usd: held + entry, held, entry };
}
