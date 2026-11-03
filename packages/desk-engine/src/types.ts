/**
 * THE ENGINE'S VOCABULARY — every number it decides on, and the two that
 * killed the Python system.
 *
 * ── 1. THE ONE-SIDED PRICE (design spec §6) ─────────────────────────────────
 * The Python desk carried ONE float per instrument. `store.py:139` is where
 * bid/ask arrived on the tick and were thrown away, and every downstream rule
 * then had to guess which side of a spread it was standing on. The visible
 * cost: MTM and the hard target lock were marked at mid, so a short book read
 * as profitable at prices it could not actually buy back at, and the lock
 * fired on money that was never there.
 *
 * So `Quote` is the unit of price here, never a float, and `bid`/`ask` are
 * BOTH-OR-NEITHER: a half-updated pair is a book that does not exist, and the
 * engine would happily size a package off it. `ltp` rides along because a
 * genuinely one-sided contract still has to be valued somehow — flagged, not
 * silently blended (§6 "valuation vs candidacy split"). Who reads which side
 * is fixed by the table in §6: greeks off the mid, MTM off the EXIT side
 * (long→bid, short→ask), the scrap test and sell sizing off the bid.
 *
 * ── 2. ABSENT-VS-ZERO (design spec §5) ──────────────────────────────────────
 * The second killer was rule state: Python's `st[...]` dict let "this book has
 * never locked" and "this book's streak is 0" be the same read, and a dial
 * that was absent, zero, or `None` meant three different things depending on
 * which `.get()` call reached it first. `RuleState` therefore has NO optional
 * fields — every key is present with an explicit zero-value, `EMPTY_RULE_STATE`
 * is the single spelling of "fresh book", and `hasGreeks` replaces the
 * `netΓ == 0.0` sentinel that a failed IV solve and a genuinely flat book both
 * used to produce.
 *
 * The key names mirror Python's `st[...]` 1:1 (noted per field) so the parity
 * fixtures of Task 4 can diff engine state against the Python run structurally
 * rather than by eye.
 *
 * PURE: no clock, no feed, no Mongo. `nowMs`, `dateIst` and `minuteOfDay` are
 * arguments precisely so a fixture can replay a session that is long over.
 */

import type { VenueSpec } from '@algomaker/venue';
import { BS_EMPTY, type BullSState } from './bull-s/state.ts';

export type Side = 'Buy' | 'Sell';
export type OptType = 'CE' | 'PE';
/** What a leg is. A share leg is a `'future'` too: delta-1, no gamma. */
export type LegKind = 'option' | 'future';
export type Mode = 'paper' | 'live';
export type PricingMode = 'parity' | 'live';

/** Two-sided quote. bid/ask are BOTH-OR-NEITHER (a one-sided tick never
 * half-updates a book). asOf is epoch ms of the last update. */
export interface Quote {
  readonly bid: number | null;
  readonly ask: number | null;
  readonly ltp: number | null;
  readonly asOf: number;
}

export interface StrikeQuote {
  readonly strike: number;
  readonly ce: Quote | null;
  readonly pe: Quote | null;
}

export interface ChainSnap {
  readonly symbol: string;
  readonly expiry: string;        // YYYY-MM-DD
  readonly step: number;          // strike step
  readonly lotSize: number;
  readonly future: Quote;         // the forward for Black-76
  readonly spot: number;          // the forward of THIS chain's expiry (live: parity-implied for dl_parity_forward delta-lean books, the future mid for recenter books); Python 'future' close in parity
  readonly strikes: ReadonlyArray<StrikeQuote>;
  readonly asOf: number;
}

export interface LegView {
  readonly instrument: string;    // real tradingsymbol
  /**
   * ABSENT = `'option'`, and every desk book's legs are absent: optional so the
   * desk's leg mappers stay untouched.
   *
   * A `'future'` leg (a future, or shares) is MEASURED, never acted on: the
   * corridor counts it as `sign x shares` of delta and no gamma, and `decide()`
   * hands every tier that can name a leg the options alone (`engine.ts`). By
   * convention it carries strike 0, `optType` 'CE', delta 1 and
   * gamma/vega/theta 0, which the engine never reads. `hasGreeks` IS read: the
   * corridor believes it like any other leg's.
   */
  readonly kind?: LegKind;
  readonly strike: number;
  readonly optType: OptType;
  readonly side: Side;            // Sell = short
  readonly lots: number;          // always positive; side carries direction
  readonly lotSize: number;
  readonly entry: number;         // per-share entry price
  readonly openedByEngine: boolean;
  /**
   * WHICH DELTA-LEAN BET PUT THIS LEG HERE, under the V1 controller — its
   * `RuleState.dlLeanId`, carried through the mark unchanged.
   *
   * HISTORY, not a current field. The v1 controller DECIDED off this stamp: it
   * read the P&L of the legs carrying its current lean and added size on a new
   * peak, cut on the drawdown from it, and stopped the lean on its own floor.
   * The hold-and-adjust engine has no lean and no such rule — every exit reads
   * `totalPnl` (`cumRealized + Σ mtm`), never a per-lean or stored figure — so
   * `dlLeanId` is gone from
   * `RuleState` and this field is carried for round-trip fidelity on a stored
   * leg rather than read by any current rule. `apps/api/src/contract.ts` says
   * the same thing about the wire shape.
   *
   * `''` = UNSTAMPED, and it is what this engine writes on every leg it opens,
   * alongside every manual leg, every recenter leg and every leg from before
   * stamping existed.
   *
   * REQUIRED, never optional, for the reason this file's §2 gives: a mapper that
   * omitted it would hand the controller `undefined`, which would then match the
   * `undefined` of every other unmapped leg.
   */
  readonly leanId: string;
  readonly iv: number | null;     // marked IV (solved off mid; null = solve failed)
  readonly delta: number;         // per-share, unsigned magnitude with sign applied by consumers
  readonly gamma: number;
  /**
   * Per-share, per CALENDAR DAY, and NEGATIVE for a long option — the
   * contract's decay, not the position's: a short leg carries the same
   * negative number and the consumer applies the side, exactly as it does for
   * `delta`. Read ONLY when `hasGreeks` is true; the 0 beside a failed solve
   * is a zero-init and means "not marked", never "costs nothing to hold".
   */
  readonly theta: number;
  /**
   * Per-share, per 1 POINT of vol (i.e. per 1%, not per 1.0) — again the
   * contract's, unsigned by side. Read ONLY when `hasGreeks` is true.
   */
  readonly vega: number;
  readonly hasGreeks: boolean;    // false = IV solve failed; NEVER encoded as 0.0
  readonly mtm: number;           // exit-side in live pricing, mid-or-ltp in parity
  readonly exit: Quote;           // the pair mtm was valued off
}

export interface MarginInput {
  readonly value: number;
  readonly source: 'broker' | 'model';
  readonly asOf: number;
  readonly fresh: boolean;        // broker + within staleness window
}

/**
 * Delta and gamma of a strike the book does not hold, signed by wing (CE ≥ 0,
 * PE ≤ 0) exactly as `marking.ts`'s `strikeGreeks` signs them. `null` means the
 * strike is not measurable and is therefore not a candidate — there is no
 * `dps = 0.30` stand-in anywhere behind this type (spec §5).
 */
export type StrikeGreekReader = (
  strike: number,
  optType: OptType,
) => { readonly delta: number; readonly gamma: number } | null;

export interface EngineInputs {
  readonly tag: string;
  readonly mode: Mode;
  readonly nowMs: number;
  readonly dateIst: string;       // YYYY-MM-DD
  readonly minuteOfDay: number;   // IST minutes since 00:00 (09:15 = 555)
  readonly dte: number;           // calendar days to expiry (0 on expiry day)
  readonly chain: ChainSnap;
  readonly legs: ReadonlyArray<LegView>;
  readonly protectedQty: Readonly<Record<string, number>>; // instrument -> lots
  readonly cumRealized: number;
  readonly margin: MarginInput;
  readonly pendingLots: number;   // remaining working-package lots
  readonly repairHold: boolean;   // desk-api repair-Apply hold is fresh: skip the action pass
  readonly pricing: PricingMode;
  /**
   * PARITY ONLY, and the one optional field on this type — read `marking.ts`'s
   * `greekReader` before using it.
   *
   * `ChainSnap` carries QUOTES, and the engine derives every strike greek from
   * them through a Black-76 IV solve. The Python decision fixtures carry the
   * generator's own greeks BESIDE a price, and the two disagree by up to ~8.5%
   * on gamma (measured on the 330 CE of `rally-itm-margin-armed`, ticket 06 §2).
   * A parity suite that re-solved would fail for pricing-model noise rather
   * than for a logic defect, and the rules it is checking size real packages off
   * that number (`lots = round(excess / (dps × lotSize))`), so the noise lands
   * on a rounding boundary sooner or later.
   *
   * So the parity adapter hands the RECORDED rows in here and the shed path
   * consults them first. It is IGNORED unless `pricing === 'parity'`
   * (`greekReader` enforces that, not the caller): a stray reader on a live
   * inputs object must never steer a live book off numbers the engine did not
   * measure — which is the whole defect this migration exists to retire.
   */
  readonly strikeGreeksOverride?: StrikeGreekReader;
  /**
   * The venue this book trades on. ABSENT IS NSE, so every existing caller,
   * fixture and parity suite is unchanged. On DX the NSE session gate and the
   * 15:30 settle do not apply: the market is 24x7 and greeks price to the
   * venue's expiry instant (`@algomaker/venue`).
   */
  readonly venue?: VenueSpec;
}

export type EngineAction =
  | {
      readonly op: 'open';
      readonly strike: number;
      readonly optType: OptType;
      readonly side: Side;
      readonly lots: number;
      /**
       * The delta-lean lean this leg belongs to, stamped by `decideDeltaLean`
       * on every open its controller emits.
       *
       * ABSENT on every recenter action — that engine has no leans — which is
       * why it is OPTIONAL here and REQUIRED, as `''`, on the read side
       * (`LegView.leanId`). The asymmetry is the point: a write path that has
       * nothing to say says nothing, and a read path that says nothing would
       * produce a lean holding nothing with no type error to show for it.
       */
      readonly leanId?: string;
      /**
       * This open ADDS to a position the book may already hold.
       *
       * Set by `phaseShed`, which accumulates: it re-picks the best strike and
       * sells more of it, held or not. Without this, `book.ts` cannot tell that
       * open from a decision merely repeating itself, so it refused both — and
       * three recenter books spent six days unable to act on their own shed
       * (2026-09-16).
       *
       * ABSENT means "a new position", which is every other open on the desk.
       * Optional for the same reason `leanId` is: a write path with nothing to
       * say says nothing.
       *
       * INVISIBLE TO PARITY BY CONSTRUCTION — `parity.test.ts` keys an open on
       * strike/optType/side/lots and reads no other field, so the legacy
       * comparison this engine is pinned against is unchanged.
       */
      readonly add?: boolean;
    }
  | { readonly op: 'close'; readonly instrument: string }
  | { readonly op: 'resize'; readonly instrument: string; readonly targetLots: number };

/**
 * The triggers, as a VALUE — the type is derived from it, not beside it.
 *
 * A type alone cannot be checked at a boundary, and desk-api's engine endpoint
 * has to check one: a `trigger` that arrives over HTTP is untrusted text. The
 * alternative was for the validator to restate this list, which is a second
 * copy that agrees today and drifts the first time a rule is added — and the
 * drift is silent, because an unknown trigger is only ever written to a journal.
 */
export const TRIGGERS = [
  'shift', 'shed', 'scrap', 'lock', 'margin', 'expiry',
  'eod', 'recycle', 'unwind', 'balance', 'none',
  // ── THE DELTA-LEAN FAMILY's own seven ─────────────────────────────────────
  // In the SAME list rather than a second one: desk-api validates an incoming
  // `trigger` against this value, and a second list is a second copy that
  // agrees today and drifts silently tomorrow.
  //
  // Widening it moves NO existing decision. `GUARD_TRIGGERS`, `PHASE_R_TRIGGERS`
  // and `DL_EXIT_TRIGGERS` in `apps/supervisor/src/engine-host.ts` are explicit
  // sets, not complements, so nothing here joins them by accident.
  //
  //   dl-stop     the day's rupee backstop tripped; terminal until the day rolls
  //   dl-open     the one package of the day went on (§6.1) — on a PLAYBOOK
  //               book, a trade's entry, stage 1 or stage 2
  //   dl-add      a pyramid: the trend is the side the book already leans (§6.2)
  //   dl-neutral  an add that NEUTRALISES — the flip buy, or the sideways sell
  //   dl-target   the day target was made; the book banks it and stops
  //   dl-stuck    the cap or the adjust limit blocks every move and the book is
  //               losing: minimise the downside and stop
  //   dl-exit     a PLAYBOOK's own exit (six-playbooks spec §4.5, §4.8): a
  //               stop, the trail, take profit, the time exit or a stage-2
  //               abort, and the reason names which. It closes the whole book,
  //               shorts first, and is re-sent every pass until the book is flat
  //
  // ADDS ONLY (D2). Of the seven, exactly four take risk off — `dl-stop`,
  // `dl-target`, `dl-stuck` and `dl-exit` — and those four are what the host's
  // `DL_EXIT_TRIGGERS` must name (spec §4.5): the fast path, the pre-emption of
  // a working add. That set is explicit, so `dl-exit` joins it by an edit
  // there and never by appearing here. `dl-open`, `dl-add` and `dl-neutral`
  // can never carry a close. `dl-exit` is LAST so every trigger before it keeps
  // its place.
  'dl-stop', 'dl-open', 'dl-add', 'dl-neutral', 'dl-target', 'dl-stuck', 'dl-exit',
  // ── THE BULL-S BOOK's eight (Delta spec §6.3) ─────────────────────────────
  // Appended, so every trigger above keeps its place. Like the delta-lean
  // family, joining this list moves no host set: `GUARD_TRIGGERS` and
  // `DL_EXIT_TRIGGERS` are explicit, and a BULL-S exit joins the host's
  // pre-emption set by an edit there.
  //
  //   bs-entry   a straddle sold at a crossed grid level
  //   bs-stop    one straddle bought back on its summed-ask stop (or a half
  //              straddle closed)
  //   bs-target  the book's P&L since the arm reached the target: close all, halt
  //   bs-loss    ... fell to the loss cap: close all, halt
  //   bs-flat    `bs_flat_before_expiry_min` reached: close all, halt
  //   bs-close   the operator's Close book: close all, halt
  //   bs-rearm   a halt cleared (by the operator, or by `bs_after_halt` 1)
  //   bs-expiry  at or past the expiry instant: no orders; settlement books the legs
  'bs-entry', 'bs-stop', 'bs-target', 'bs-loss', 'bs-flat', 'bs-close', 'bs-rearm', 'bs-expiry',
] as const;

export type Trigger = (typeof TRIGGERS)[number];

/**
 * The DEFERRED debit on the recycle bank — Python's `state_commit`
 * (`playbooks.py:3810-3812`), reported beside the state rather than only folded
 * into it.
 *
 * `base` is the bank the sale was sized against and `value` what remains if it
 * fills; `strike`/`optType`/`lots` identify the sale, so a caller that
 * downsized or dropped it can scale or discard the debit instead of banking a
 * spend that never happened. `engine.decide` does exactly that scaling as the
 * last step of a pass (`engine.py:946-1006`).
 *
 * IN THE VOCABULARY, not in `tiers.ts` where the recycle arm lives, because
 * `EngineDecision` carries one: a bank movement is a fact about the decision,
 * the same kind of thing as its actions and its state, and putting it here is
 * what keeps `types.ts` from having to import a tier.
 */
export interface RecycleCommit {
  readonly base: number;
  readonly value: number;
  readonly lots: number;
  readonly optType: OptType;
  readonly strike: number;
}

/**
 * A `RecycleCommit` after the orchestrator has weighed it against the package
 * that actually survived the sell gate and the margin cap.
 *
 * `keptLots` is how many of the `lots` the commit was sized against are still
 * in the decision, and it is the ONLY field that says how much of the spend was
 * really taken:
 *
 *   applied = base + (value − base) × min(1, keptLots / lots)
 *
 * so `keptLots: 0` means NOTHING was applied and `stateAfter.rcCredit` is
 * untouched — the sale the debit would have paid for was dropped, and the bank
 * keeps its money for the next mark. A ledger consumer must compute the applied
 * amount from this rather than assume `value`.
 */
export interface AppliedCredit extends RecycleCommit {
  readonly keptLots: number;
}

/**
 * The three ways a package may be worked (spec §8) — see
 * `EngineDecision.urgency`, which is the only place one is chosen.
 *
 * A SUPERSET of the wire's `WorkMode` (`contract.ts`) rather than the same type,
 * and deliberately: `WorkMode` is the two values desk-api's engine endpoint
 * understands, and `'ladder'` is the ABSENCE of one. Joining them would make
 * "no work mode" a work mode on the wire.
 */
export type Urgency = 'passive' | 'urgent' | 'ladder';

export interface EngineDecision {
  readonly action: 'hold' | 'adjust' | 'flatten';
  readonly trigger: Trigger;
  readonly reason: string;
  readonly actions: ReadonlyArray<EngineAction>;
  readonly stateAfter: RuleState;
  /**
   * THE STATE THIS MARK MOVED WHETHER OR NOT ANYTHING IS ROUTED — the tiers
   * that keep counting while the desk does nothing.
   *
   * `stateAfter` is the state of a decision that HAPPENS. The supervisor,
   * though, is allowed to not act on one: `confirm_ms` damping parks a trigger
   * that has not persisted, a package can be dropped before it is posted, and
   * desk-api can refuse it outright (spec §7, §8). On every one of those paths
   * the ACTIONS did not happen — but the MARK did, and three counters moved
   * with it: the target lock's confirmation streak AND its dip-disarm
   * (`guards.ts` §2), the gamma-anchor EMA, and the once-a-session EOD stamp
   * (`shed.ts` §1: "the two tiers that move on every mark, holds included").
   *
   * Persisting `stateAfter` on such a pass would bank a spend that never
   * happened; persisting NOTHING loses the disarm, and a streak that survives
   * its own dips counts NON-CONSECUTIVE marks — which is precisely the defence
   * TCS 2026-06-19 cost this desk (one 09:15 mark printed +17L on a book that
   * was really −21L). So the two are reported separately and the caller picks:
   * `stateAfter` when the decision is routed, `markState` when it is not.
   *
   * ON A HOLD THEY ARE THE SAME OBJECT-SHAPED VALUE, by construction — a hold
   * emits no actions, so it has no acting delta to leave out. They diverge only
   * on an `adjust`/`flatten`, where `markState` excludes the scrap ban, the
   * recycle bank movement and the emit-reset of the breach streak.
   */
  readonly markState: RuleState;
  /**
   * HOW HARD THIS PACKAGE IS TO BE WORKED — spec §8's three urgency classes,
   * stated by the engine that decided rather than re-derived by the host.
   *
   * There were two before this field existed and neither was honest. The host
   * had `GUARD_TRIGGERS.has(trigger) ? 'urgent' : undefined`, which is a lookup
   * table over a trigger NAME — so the same trigger could never be worked two
   * ways, and the delta-lean book's 14:50 passive flatten and its 14:55 urgent
   * one are the same `'eod'`. And `decideDeltaLean` answered that by overloading
   * `makerQuote`, which means something else entirely (below): a package marked
   * "the chain would not take this sale" is REPRICED at Black-76 theoretical and
   * alerted at ERROR, so an ordinary passive add went out at a model price with
   * an alarm attached. Both readings are gone; this field is the channel.
   *
   *   `'passive'`  work it. The peg joins the touch, follows it, and crosses
   *                once at `chase_max_ms`. Every add, and the 14:50 flatten.
   *   `'urgent'`   cross now, whole, within a worst-price bound. Every guard
   *                exit, every delta-lean cut, stop and roll, and the 14:55
   *                flatten.
   *   `'ladder'`   the blind ladder: no work mode at all, so the gateway
   *                escalates off the original limit without reading a quote.
   *                The residual past `dl_flat_by_min`, which must be out.
   *
   * NOTHING CHANGES FOR THE RECENTER ENGINE. It sets this from exactly the
   * binary rule the host applied before — a guard trigger is `'urgent'` and
   * everything else is `'passive'` — so its wire is the same wire.
   *
   * Required, like every other field on this type: an absent urgency and a
   * passive one must never be the same read (§2).
   */
  readonly urgency: Urgency;
  /**
   * THE CHAIN WOULD NOT TAKE THIS SALE — quote it, do not cross it (spec §8).
   *
   * `shed.ts`'s liquidity gate refuses a strike whose book is one-sided, wider
   * than `sell_max_spread_pct`, or older than `quote_max_age_ms`, and it
   * deliberately returns the sale it wanted anyway rather than holding silently
   * (`shed.ts` §4: "gate failure is a maker quote, never a silent hold"). The
   * flag is that refusal, carried out to the supervisor, which prices the sale
   * at Black-76 theoretical and works it PASSIVELY instead of joining a touch
   * the gate has already judged untradeable.
   *
   * A caller that ignores it routes into exactly the book the gate refused,
   * which is why the flag rides on the decision rather than the actions being
   * suppressed — suppressing them would be the silent hold §6/§8 forbid.
   *
   * `false` on every other decision, INCLUDING a guard exit and a hold: an
   * urgency exit crosses whatever is there by design, and a hold has no sale to
   * quote. It says nothing about whether the package is worth taking — only
   * about which side of the spread it may be worked from.
   */
  readonly makerQuote: boolean;
  /**
   * The bank movement the playbook PROPOSED, applied to `stateAfter` only to
   * the extent its lots survived — read `keptLots` before believing `value`.
   *
   * It is deliberately NOT "the applied movement": the proposal is reported
   * whole even when the sell gate or the margin cap dropped the sale outright,
   * because a ledger row that showed nothing on such a mark could not
   * distinguish "the bank did not move" from "no bank rule ran". `keptLots: 0`
   * is the honest spelling of the first, and `AppliedCredit` carries the
   * arithmetic that turns the pair into an amount.
   *
   * Two readers want it. A ledger row can say which sale paid for which bank
   * movement, which `rcCredit` alone cannot (the same number can be reached
   * from different sales). And the parity suite compares it structurally
   * against Python's recorded `state_commit`: the fixture generator calls the
   * playbook body only, so its `state_after` is PRE-commit, and without this
   * field a replay could only check the resulting number — which agrees with a
   * wrong `base` whenever the package fills whole.
   */
  readonly creditCommit: AppliedCredit | null;
}

/**
 * THE PLAYBOOK FRAME'S OWN ROW (six-playbooks spec §4.4) — `RuleState.pb`.
 *
 * A playbook book is a delta-lean book, so it already carries every `dl*`
 * field below; what it adds is a TRADE, which the hold-and-adjust engine has
 * no word for: a day may hold several, each with its own entry, its own stops
 * and its own exit latch. That is this object, nested rather than spread into
 * thirty-four more fields of `RuleState`, because it is ONE thing — reset
 * whole by the day roll, hydrated whole by one function
 * (`hydratePlaybookState`), and read by one path.
 *
 * The ring a book reads the index from is lost on a restart, so everything a
 * trade must survive a restart with is copied here: the session's open, high
 * and low, the frozen day move, and every stamp a stop is measured from.
 *
 * Every field is REQUIRED with an explicit zero-value, for the reason the file
 * header gives, and each says below what its zero means. For an index level
 * or a clock, 0 can safely mean "none": no index prints 0 and no epoch is 0.
 * The rupee stamps (`basePnl`, `peakPnl`) are different — 0 is a real figure
 * there — and they are read only while `tradeOpenMs` says a trade is open.
 */
export interface PlaybookState {
  /** The session's `O`: the median of the first three index samples at or
   * after 09:15:00 IST, so one bad opening tick cannot be it. 0 = not seen
   * yet today. */
  readonly dayOpen: number;
  /** The session's high and low so far, folded off the ring. 0 = none. */
  readonly dayHigh: number;
  readonly dayLow: number;
  /** Epoch ms of the first and the newest sample folded into the three above.
   * The first is what `dayComplete` is judged on (a fold that began after
   * 09:16 did not see the open); the newest is where the next fold resumes
   * (a minute behind it, so the median-of-3 has neighbours — re-reading a
   * folded sample is harmless, a max of a max). Written only with a change,
   * or every five minutes of a quiet tape (`playbook/session.ts`). 0 = none. */
  readonly statsFromMs: number;
  readonly statsLastMs: number;
  /** The longest hole between two consecutive folded index samples today, in
   * ms. A tape with a hole past `pb_max_gap_min` may have missed the very
   * move its high or low should hold, so the day stops being `dayRobust`.
   * 0 = no hole measured yet (fewer than two samples folded). */
  readonly maxGapMs: number;
  /** `Dday`, the day's implied one-session move (spec §4.2), FROZEN at its
   * first reading at or after 09:16 so a stop sized in it cannot drift with
   * the afternoon's straddle. 0 = not frozen yet. */
  readonly dayImplied: number;
  /** Trades opened today. Capped by `pb_max_entries`. */
  readonly entries: number;
  /** When the current trade's first package routed. 0 = no trade open. */
  readonly tradeOpenMs: number;
  /** What the trade expresses: `none` is a neutral structure (the fly).
   * `''` = no trade. */
  readonly side: 'up' | 'down' | 'none' | '';
  /** 1 = the protective legs are routed and the shorts are PENDING (D2, buy
   * before you sell); 0 = no package, or a complete one. */
  readonly stage: number;
  /**
   * The stage-2 sale of the trade's ENTRY: each short, and its `cover` — the
   * strike of the same-type protective long that covers it. Stage 2 checks
   * that THAT leg is held before it sells, so a package that filled only one
   * wing cannot sell the short the other wing was bought to cover (D1). A
   * pyramid add is a single-stage buy and never leaves one.
   */
  readonly planShorts: ReadonlyArray<{
    readonly strike: number;
    readonly optType: OptType;
    readonly cover: number;
  }>;
  /** Lots per leg the plan was sized at — the shorts sell exactly this. */
  readonly planLots: number;
  /** When stage 1 routed, and the INDEX level `S` then — the stage-2 abort's
   * clock and its distance reference. The index, not the forward: the
   * forward's source can change between two passes (parity, then index x
   * carry), and an abort must measure what the market did, not a change of
   * method. 0 = no stage 1. */
  readonly stageMs: number;
  readonly stageSpot: number;
  /** The first pass that saw every protective leg held with NOTHING in flight
   * — the moment stage 2 became possible. 0 = not yet. */
  readonly stageReadyMs: number;
  /** The index level when the trade opened. */
  readonly entrySpot: number;
  /** The ATM straddle when the trade opened — the unit an index stop is
   * measured in for this trade. */
  readonly entryStr: number;
  /** Reversal Spread: the morning extreme the trade faded. */
  readonly entryExtreme: number;
  /** Expiry Gamma Breakout: the consolidation box the trade broke. */
  readonly boxHi: number;
  readonly boxLo: number;
  /** `totalPnl` when the trade began, so `totalPnl - basePnl` is THIS trade's
   * rupees — banked plus open — on a day that may hold several. */
  readonly basePnl: number;
  /** The best trade P&L so far — the trailing floor's peak — and whether that
   * floor is armed. A floor that arms LATE (on `pb_late_trail_start`, never
   * armed before `pb_late_min`) restarts the peak at the P&L it armed on: the
   * morning's best is not what the afternoon's floor protects (D5). */
  readonly peakPnl: number;
  readonly trailArmed: boolean;
  /** Pyramid adds this trade (D6: at most `pb_max_adds`). */
  readonly adds: number;
  /** The debounce clock of an index-based stop: when its condition was first
   * seen to hold. 0 = the condition is off. */
  readonly condSinceMs: number;
  /** The debounce clock of a RUPEE stop (`pb_rupee_hold_s`): one mark off a
   * briefly wide quote is not a loss. 0 = the condition is off. */
  readonly rupeeSinceMs: number;
  /** THE EXIT LATCH. Set when a playbook exit fires and cleared only once the
   * book is flat, so a partly filled close is re-sent on every pass rather
   * than abandoned when the condition that fired it goes away. */
  readonly exiting: boolean;
  /** The latched exit's reason and urgency, re-sent unchanged. '' unless
   * `exiting`. */
  readonly exitReason: string;
  readonly exitUrgency: 'passive' | 'urgent' | 'ladder' | '';
  /** When the exit latched. 0 = no exit latched. */
  readonly exitMs: number;
  /** No more entries today — a final exit (the time exit) sets it. */
  readonly doneForDay: boolean;
  /** When the last trade finished: the re-entry cooldown's reference.
   * 0 = never today. */
  readonly lastExitMs: number;
  /** The debounce clock of the frame's DAY lines, the backstop and the target
   * (`pb_rupee_hold_s`): when `totalPnl` first stood at or through either.
   * A DAY field, not a trade's — a trade's finish leaves it, the day roll
   * clears it. 0 = neither line holds. */
  readonly dayLineSinceMs: number;
}

/** The single spelling of "a playbook that has not traded today" — what a
 * fresh row starts from and what the day roll resets to. */
export const EMPTY_PLAYBOOK_STATE: PlaybookState = {
  dayOpen: 0, dayHigh: 0, dayLow: 0, statsFromMs: 0, statsLastMs: 0, maxGapMs: 0, dayImplied: 0,
  entries: 0, tradeOpenMs: 0, side: '', stage: 0, planShorts: [], planLots: 0,
  stageMs: 0, stageSpot: 0, stageReadyMs: 0,
  entrySpot: 0, entryStr: 0, entryExtreme: 0, boxHi: 0, boxLo: 0,
  basePnl: 0, peakPnl: 0, trailArmed: false, adds: 0, condSinceMs: 0, rupeeSinceMs: 0,
  exiting: false, exitReason: '', exitUrgency: '', exitMs: 0, doneForDay: false, lastExitMs: 0,
  dayLineSinceMs: 0,
};

/** Persistent per-book rule state. Mirrors Python st[...] keys 1:1 so
 * parity fixtures can diff it structurally. All fields REQUIRED with
 * explicit zero-values — the absent-vs-zero trap died in the port. */
export interface RuleState {
  readonly rcCredit: number;              // st["rc_credit"]
  readonly rcEodDay: string;              // st["rc_eod_day"] ('' = never)
  readonly gkAnchor: number;              // st["gk_anchor"] (0 = unset)
  readonly gkStreak: number;              // st["gk_streak"]
  readonly scrapBanned: ReadonlyArray<string>;   // st["scrap_banned"] strike:optType:expiry keys
  readonly targetStreak: number;          // st["target_streak"]
  readonly targetLocked: boolean;         // st["target_locked"]
  readonly rcStack: ReadonlyArray<{ readonly strike: number; readonly optType: OptType; readonly lots: number }>; // _rc_stack for LIFO unwind
  readonly lastActionMs: number;          // cooldown reference

  // ── THE DELTA-LEAN BOOK (hold-and-adjust spec §3) ─────────────────────────
  // A second decide path shares this one state row, so every field below is
  // prefixed `dl`. None of it is read by a recenter book and none of it is
  // written by one — but it is REQUIRED here, not optional, for the reason the
  // file header gives: an absent `dlStopped` and a book that has not stopped
  // must never be the same read.
  //
  // ONE P&L LEVEL, and it is the TAG's — the day's on an intraday book, the
  // book's life on a `dl_hold_to_expiry` one. The v1 controller had two — the lean's
  // own peak and bank beside the day's — because it added on a new peak and cut
  // on the drawdown from it. This engine does neither: it opens once, adjusts
  // by adding, and exits on the day target, the day backstop, the clock or the
  // stuck rule. All four read `totalPnl(inputs)` (banked plus the open book's
  // mark), so the only stored money is `dlDayRealized`, which the host's
  // `#settle` writes for the ledger and the dashboard and the engine reads
  // nowhere. A budget that counted only banked money would sail past an
  // unrealised loss it exists to stop.

  /** The IST date this book last reset itself for. '' = never. */
  readonly dlDayStarted: string;
  /**
   * TERMINAL FOR THE DAY once set, and cleared only by a new `dlDayStarted` —
   * or for the BOOK'S LIFE when `dl_hold_to_expiry`, whose roll keeps it.
   *
   * Set by the EOD flatten, the day target and the stuck exit once the book is
   * flat, and by the day-loss backstop IMMEDIATELY — a backstop that waited for
   * the flatten to fill could add one more package into the loss it fired on.
   */
  readonly dlStopped: boolean;
  /** 0 = not opened today. The day's ONE package (D3) went on at this instant —
   * the BOOK's one package when `dl_hold_to_expiry`, whose roll keeps it. */
  readonly dlOpenedMs: number;
  /** What the open expressed. 'none' = a quiet-regime strangle. '' = not opened. */
  readonly dlOpenSide: 'up' | 'down' | 'none' | '';
  /** Adjustment packages routed today, AFTER the open. Capped by
   * `dl_max_adjusts_day`; the open itself is not counted. */
  readonly dlAdjustsToday: number;
  /** The cooldown's reference. THE OPEN COUNTS AS THE FIRST package, so the
   * first adjustment is a full `dl_adjust_cooldown_s` after the open rather
   * than available on the next tick. 0 = nothing routed today. */
  readonly dlLastAdjustMs: number;
  /**
   * The regime that justified the last package — open or adjustment.
   *
   * THE SAME REGIME NEVER JUSTIFIES TWO PACKAGES IN A ROW (§5 step 7). This is
   * what stops a trend that merely persists from pyramiding every cooldown: the
   * tape has to change its mind and come back before the book adds again.
   * '' = nothing routed today.
   */
  readonly dlLastAdjustRegime: string;
  /** The detector's last classification. '' = not yet classified (warm-up),
   * never "quiet" — a book that has not measured is not a calm one. */
  readonly dlRegime: string;
  /** When `dlRegime` last CHANGED. The confirmation reference for
   * `dl_adjust_confirm_s`, and the day roll anchors it at the roll instant so
   * the morning's first confirm window is measured from this session. */
  readonly dlRegimeSinceMs: number;
  /**
   * 0, or when an adjustment first became WANTED-BUT-BLOCKED by the margin cap
   * or by `dl_max_adjusts_day`. The stuck exit's clock (§6.4).
   *
   * Reset to 0 on any tick where the block clears OR the loss condition clears,
   * so the clock measures one continuous stretch rather than a total.
   */
  readonly dlBlockedSinceMs: number;
  /**
   * 0, or when `totalPnl` was first seen at or through the backstop or the
   * target — the debounce clock of steps 3-4 on a HOLD book
   * (`dl_rupee_hold_s`). One clock for both lines, as `pb.dayLineSinceMs` is.
   *
   * Reset to 0 on any pass that reads inside both lines, and by the day roll,
   * so it measures one continuous stretch of one session. Never written on an
   * intraday book, whose lines act on the first mark.
   */
  readonly dlRupeeSinceMs: number;
  /**
   * Realised rupees today, folded by the host's `#settle` (spec §7).
   *
   * WRITTEN BY THE HOST, READ BY NOBODY IN THE ENGINE, and that asymmetry is
   * deliberate: the exits all read `totalPnl`, which already includes the same
   * money through `cumRealized`. This field exists so a ledger row, the run
   * page and an operator can see the day's banked half on its own without
   * subtracting a mark. Zeroed by the day roll; `cumRealized` is not (it is the
   * TAG's bank, and a delta-lean tag lives one trading day anyway).
   */
  readonly dlDayRealized: number;

  // ── THE PLAYBOOK BOOK (six-playbooks spec §4.4) ───────────────────────────
  /**
   * ONE ROW, the playbook frame's alone. No recenter book and no plain
   * delta-lean book reads or writes it — they carry `EMPTY_PLAYBOOK_STATE`
   * here and nothing ever moves it. REQUIRED, not optional, for the reason the
   * delta-lean block gives: an absent `pb.exiting` and an exit that is not
   * latched must never be the same read.
   *
   * Nested, so `sameRuleState`'s `JSON.stringify` equality covers it with
   * nothing added, and LAST, so every field above keeps its place in a stored
   * row. The state store reads it back through `hydratePlaybookState`.
   */
  readonly pb: PlaybookState;
  // ── THE BULL-S BOOK (Delta spec §6.3) ─────────────────────────────────────
  /**
   * ONE ROW, the BULL-S path's alone; every other book carries `BS_EMPTY`
   * here and nothing moves it. REQUIRED for the reason `pb` is, and LAST so
   * every field above keeps its place in a stored row. The state store reads
   * it back through `hydrateBullState`.
   */
  readonly bs: BullSState;
}
export const EMPTY_RULE_STATE: RuleState = {
  rcCredit: 0, rcEodDay: '', gkAnchor: 0, gkStreak: 0, scrapBanned: [],
  targetStreak: 0, targetLocked: false, rcStack: [], lastActionMs: 0,
  dlDayStarted: '', dlStopped: false,
  dlOpenedMs: 0, dlOpenSide: '',
  dlAdjustsToday: 0, dlLastAdjustMs: 0, dlLastAdjustRegime: '',
  dlRegime: '', dlRegimeSinceMs: 0,
  dlBlockedSinceMs: 0, dlRupeeSinceMs: 0, dlDayRealized: 0,
  pb: EMPTY_PLAYBOOK_STATE,
  bs: BS_EMPTY,
};
