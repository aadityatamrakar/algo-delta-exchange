/**
 * WHAT A LEG IS WORTH, AND WHAT IT IS ACTUALLY DOING — marks, IV and greeks
 * off the two-sided book.
 *
 * This is the layer where the Python desk lost money quietly, twice, in two
 * different ways. Both are structural, not arithmetic, and both are why this
 * file exists as its own seam rather than as four expressions inline in the
 * rules.
 *
 * ── 1. THE MARK WAS A LAST PRINT (TCS 2440 PE, 2026-08-17) ──────────────────
 * The engine carried ONE float per instrument — mid-or-LTP, whichever the
 * store happened to hold (`store.py:139` is where bid/ask arrived on the tick
 * and were dropped). A far-OTM short like TCS 2440 PE prints rarely: its last
 * trade was 14:20 under a book that moved every second, so every downstream
 * number — MTM, `total_pnl`, the hard target lock — was computed against a
 * price hours stale, and against the WRONG SIDE of the spread besides. A short
 * marked at the mid reads as profitable at a price it cannot buy back at; the
 * target lock then fires on money that was never there. BHEL on 2026-08-21 is
 * the same failure at book scale: "+25k" on screen all afternoon, −7,061 the
 * moment the last leg actually filled.
 *
 * So: **LTP is not a valuation basis** (operator directive, 2026-08-21, ported
 * from `2026-08-21-exit-side-marks-design.md`). In `pricing: 'live'` a leg is
 * worth what CLOSING it would fetch and nothing else — a long at the bid, a
 * short at the ask — and a contract whose book has never been seen is honestly
 * unpriced rather than guessed at. `pricing: 'parity'` reproduces Python's
 * mid-or-LTP float, and exists for ONE purpose: replaying the Python decision
 * fixtures number-for-number (design spec §12). It is not settable from the UI.
 *
 * Valuation and candidacy are deliberately split (spec §6): valuation uses the
 * last-seen two-sided pair HOWEVER OLD — the feed pushes on depth change, so an
 * un-updated pair means an unchanged book while the feed is healthy — while the
 * spread/age gates that decide what we would newly SELL live in the rules, not
 * here. Nothing in this file inspects `asOf`; it copies the pair it used into
 * `LegView.exit` so the caller can age it and say which basis a number came
 * from.
 *
 * ── 2. A MISSING GREEK LOOKED LIKE A REAL ONE (`dps = 0.30`) ────────────────
 * When the Python chain had no greek for a strike it substituted a constant:
 * `dps = abs(sd) if sd else 0.30` (`sim/rules/playbooks.py:3711` and `:4857`,
 * plus the `default_dps: float = 0.30` parameter at `:2822`) — "the 2-out
 * default when the chain has no greek". That number then flowed into best-fit
 * sizing as if it had been measured, so an unpriceable strike sized a package
 * exactly like a real 30-delta one. Its sibling defect: a failed IV solve
 * zero-filled the greeks, and `netΓ == 0.0` then meant both "we could not mark
 * this book" and "this book is genuinely flat" (see `types.ts` §2).
 *
 * Both are DELETED here, per design spec §5's "deleted Python semantics":
 *   - `strikeGreeks` returns `null` when the IV does not solve. A strike whose
 *     greeks cannot be computed is not a candidate. There is no fallback.
 *   - `markLeg` sets `hasGreeks: false`. `delta`/`gamma`/`theta`/`vega` are 0
 *     alongside it because none of the four is optional, but the FLAG is what
 *     callers read; zero is never the signal. A theta of 0 in particular would
 *     read as "this leg costs nothing to hold".
 *
 * ── PRICING MODEL ───────────────────────────────────────────────────────────
 * Black-76 against the traded future, `r = RISK_FREE`, tenor in calendar days
 * over 365 and refined intraday ONLY on the expiry session — all four preserved
 * verbatim from `sensibull_tools/pricing.py` so a TS mark and a Python mark of
 * the same book are comparable rather than arguable. `chain.spot` is the
 * forward `F` (the future's mid in live mode, Python's `future` close in
 * parity), and the IV every greek is taken at is ALWAYS solved off `midOf` —
 * the mid is the market's opinion of value; the exit side is what we would
 * realise. Solving off the exit side would tilt every delta by half a spread
 * and make a short book's greeks disagree with a long book's on the same
 * contract.
 *
 * ── SIGN CONVENTIONS (read before using `delta`) ────────────────────────────
 * They differ between the two functions, on purpose:
 *   - `LegView.delta` is an UNSIGNED per-share magnitude, as `types.ts`
 *     specifies. The full signed contribution of a leg is
 *     `(optType === 'CE' ? +1 : -1) * (side === 'Sell' ? -1 : +1) * delta *
 *     lots * lotSize` — both factors are on the `LegView`, so nothing is lost.
 *   - `strikeGreeks` returns the RAW Black-76 delta, signed by wing (CE ≥ 0,
 *     PE ≤ 0), because it replaces reading a chain row — and the Python chain
 *     rows the parity fixtures were generated from are signed that way
 *     (`test/fixtures/decisions/*.json`: `"PE": {"delta": -0.02}`). Sizing
 *     callers take `Math.abs`, exactly as Python's `abs(sd)` did.
 * `gamma` is positive in both, for both wings.
 *
 * PURE: no clock, no feed. `dateIst` and `minuteOfDay` are arguments so a
 * fixture can replay a session that is long over.
 */
import { b76Greeks, b76ImpliedVol, b76Price } from '@algomaker/greeks';
import { NSE, type VenueSpec } from '@algomaker/venue';
import { DECISION_CLOCK_CLOSE_MIN } from './session.ts';
import type {
  ChainSnap,
  EngineInputs,
  LegView,
  OptType,
  PricingMode,
  Quote,
  Side,
  StrikeGreekReader,
} from './types.ts';

/**
 * The desk's risk-free rate, `pricing.py:16` exactly. A constant, not a dial:
 * every committed Python board and every parity fixture was priced at it, so
 * changing it here silently invalidates the comparison the whole migration is
 * verified by.
 */
export const RISK_FREE = 0.065;

/**
 * Floor on the remaining life of an expiry-day option, in minutes
 * (`pricing.py:81` `_MIN_REMAINING_MIN`). At the bell the honest tenor is zero,
 * but zero collapses the IV solve and zero-fills delta AND gamma — which on a
 * 0-DTE book is the entire steering signal. Five minutes keeps the greeks
 * finite through the close without pretending there is a session left.
 */
const MIN_REMAINING_MIN = 5;

/** Strikes are compared with a tolerance because a caller reaching a ladder by
 * arithmetic (`atm + n * step`) can land on 2439.999999999999. No real strike
 * ladder is finer than this, so the tolerance cannot merge two strikes. */
const STRIKE_EPS = 1e-6;

/**
 * Mid of a two-sided book; the last print only when the book is genuinely
 * one-sided; `null` when nothing has ever been seen.
 *
 * This is the VALUATION-NEUTRAL price — what IV and therefore every greek is
 * taken at, and what `parity` marks off. It is NOT what a live P&L uses; see
 * `exitPrice`.
 *
 * The LTP fallback survives here and only here: a contract with a genuine
 * one-sided book still has to be given a volatility somehow, and a greek
 * carrying half a spread of error is a different order of wrong from a P&L
 * that says a book is worth money it cannot collect (spec §6, "LTP only when
 * one-sided, flagged").
 */
export function midOf(q: Quote): number | null {
  if (q.bid !== null && q.ask !== null) return (q.bid + q.ask) / 2;
  return q.ltp;
}

/**
 * The price closing this position would actually fetch: a long sells into the
 * **bid**, a short buys back at the **ask**.
 *
 * `null` — never an LTP stand-in — when that side is absent. `bid`/`ask` are
 * both-or-neither by `Quote`'s contract, so reading one side is enough; asking
 * for the side we need also means a violated invariant degrades to "unpriced"
 * rather than to a half-book mark.
 *
 * Callers wanting a single NEUTRAL price (a parity mark, a spread mid, a
 * theoretical) want `midOf` instead.
 */
export function exitPrice(q: Quote, side: Side): number | null {
  return side === 'Sell' ? q.ask : q.bid;
}

/**
 * The price a leg marks at under the engine's pricing mode.
 *
 * `'live'` — the exit side, the only basis a real P&L, the corridor or the
 * target lock may use. `'parity'` — Python's mid-or-LTP float, for fixture
 * replay only; it ignores `side`, which is precisely the defect it reproduces.
 */
export function markPrice(q: Quote, pricing: PricingMode, side: Side): number | null {
  return pricing === 'parity' ? midOf(q) : exitPrice(q, side);
}

/** Epoch ms of an IST calendar date at UTC midnight, or null if the string is
 * not a real day. This is date arithmetic on an already-IST-resolved string,
 * so no offset is applied — the same convention as `session.ts`. */
function utcDayMs(dateIso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (m === null) return null;
  const [, ys, mos, ds] = m;
  if (ys === undefined || mos === undefined || ds === undefined) return null;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const ms = Date.UTC(y, mo - 1, d);
  if (!Number.isFinite(ms)) return null;
  // Date.UTC ROLLS OVER — '2026-02-31' silently becomes 3 March, which would
  // price two extra days of tenor and never say so. Round-trip to reject it.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/**
 * Time to expiry in YEARS: calendar days over 365, refined to the minutes left
 * in the session ONLY on the expiry day itself.
 *
 * A direct port of `pricing.py:118-149` (`year_frac_at`), including its
 * asymmetry, which is the whole point of the function:
 *
 *   - **Later expiry** → `days / 365`, and the clock is IGNORED. A pre-expiry
 *     mark must not shorten as the day wears on, or every board this desk was
 *     tuned against re-prices.
 *   - **Expiry day** → `(minutes left / 1440) / 365`. Python's plain
 *     `year_frac` collapses to 0.0 here, which fails the IV solve and
 *     zero-fills delta, gamma, theta and vega — inert corridor rules on the one
 *     day a 0-DTE book is entirely delta and gamma. A 09:20 mark prices ~6h10m
 *     of remaining life. Floored at `MIN_REMAINING_MIN`.
 *   - **Past expiry** → 0.
 *
 * The expiry-day clock runs to 15:30 (`DECISION_CLOCK_CLOSE_MIN`), not to the
 * 15:40 F&O close the greeks package prices to: these greeks size the live
 * desk's adjusts, so moving them is its own decision (session.ts). Python's
 * per-symbol `session_close_min` registry is not ported because every book
 * this engine manages is NSE equity/F&O. A `dateIst` or `expiry` that is not
 * a real day returns 0, which surfaces downstream as `hasGreeks: false` — no
 * greeks beats greeks priced off a tenor invented by month rollover.
 *
 * `venue` absent is NSE and everything above. Any other venue is 24x7 and
 * prices in calendar time to its expiry instant (`venueYearFrac` below).
 */
export function yearFrac(
  dateIst: string,
  expiry: string,
  minuteOfDay: number,
  venue: VenueSpec = NSE,
): number {
  const from = utcDayMs(dateIst);
  const to = utcDayMs(expiry);
  if (from === null || to === null) return 0;
  if (venue.id !== 'nse') return venueYearFrac(from, expiry, minuteOfDay, venue);

  const days = Math.round((to - from) / 86_400_000);
  if (days > 0) return days / 365;
  if (days < 0) return 0;

  // Expiry day. A non-finite minute is a caller bug, not a reason to zero the
  // greeks: treat it as the bell and take the floor.
  const minute = Number.isFinite(minuteOfDay) ? minuteOfDay : DECISION_CLOCK_CLOSE_MIN;
  const remaining = Math.max(MIN_REMAINING_MIN, DECISION_CLOCK_CLOSE_MIN - minute);
  return remaining / (60 * 24) / 365;
}

const IST_OFFSET_MS = 330 * 60_000;
const YEAR_MS = 365 * 86_400_000;

/**
 * A 24x7 venue's tenor: calendar time from the IST clock reading to the
 * venue's expiry instant (DX: 12:00 UTC), whole days and the clock alike.
 * Floored at `MIN_REMAINING_MIN` while the contract still trades, for the same
 * reason as NSE's expiry day; 0 at and after the instant, when it has settled.
 */
function venueYearFrac(
  fromDayMs: number,
  expiry: string,
  minuteOfDay: number,
  venue: VenueSpec,
): number {
  const minute = Number.isFinite(minuteOfDay) ? minuteOfDay : 0;
  const nowMs = fromDayMs + minute * 60_000 - IST_OFFSET_MS;
  const remaining = venue.expiryInstantMs(expiry) - nowMs;
  if (!(remaining > 0)) return 0;
  return Math.max(MIN_REMAINING_MIN * 60_000, remaining) / YEAR_MS;
}

/** The rate a venue prices at: NSE `RISK_FREE` (0.065), DX 0. */
const rateOf = (venue: VenueSpec): number => (venue.id === 'nse' ? RISK_FREE : venue.rate);

/** The identifying half of a `LegView` — what the caller knows before marking. */
export interface LegPosition {
  readonly strike: number;
  readonly optType: OptType;
  readonly side: Side;
  readonly lots: number;
  readonly lotSize: number;
  readonly entry: number;
  readonly instrument: string;
  readonly openedByEngine: boolean;
  /**
   * The delta-lean lean that opened this leg, `''` for a leg no lean owns.
   *
   * REQUIRED on this side of the boundary, not optional: the supervisor's
   * `#readBook` rebuilds a `LegPosition` field by field out of a stored
   * document, and a field it silently omitted would reach the controller as
   * `undefined` — which matches the `undefined` of every other unmapped leg and
   * produces a lean that holds nothing. See `LegView.leanId`.
   */
  readonly leanId: string;
}

/**
 * A held position plus today's book → the fully marked `LegView` the rules
 * decide on.
 *
 * Two INDEPENDENT results, and keeping them independent is the design:
 *
 *   - **Value** (`mtm`, `exit`) comes off `markPrice` — the exit side in live
 *     pricing. An unpriced contract marks 0 and carries the pair it failed on,
 *     so "worth nothing" and "never quoted" stay distinguishable: re-run
 *     `markPrice(view.exit, pricing, view.side)` and a `null` is the second
 *     case. (Do NOT test `exit.bid === null` instead — in live pricing an
 *     ltp-only quote is also unpriced while its `ltp` is set.) The spec has
 *     the action pass HOLD on such a leg rather than value it (§6).
 *   - **Greeks** (`iv`, `delta`, `gamma`, `theta`, `vega` and the `hasGreeks`
 *     flag over all five) come off `midOf` and Black-76 at `chain.spot`. A
 *     leg can be perfectly valued with no solvable IV — a deep-ITM short
 *     quoted at intrinsic is the ordinary case — and that must not suppress
 *     its P&L, nor its P&L suppress the flag.
 *
 * `delta` is an unsigned magnitude; see the sign note in the file header.
 * `theta` and `vega` are RAW — the contract's, not the position's — so a short
 * leg carries the same negative theta as a long one and the consumer applies
 * the side, exactly as it must for delta.
 */
export function markLeg(
  leg: LegPosition,
  q: Quote,
  chain: ChainSnap,
  dateIst: string,
  minuteOfDay: number,
  pricing: PricingMode,
  venue: VenueSpec = NSE,
): LegView {
  const mark = markPrice(q, pricing, leg.side);
  const shares = leg.lots * leg.lotSize;
  // `lots` is always positive; `side` carries the direction (types.ts).
  const dir = leg.side === 'Sell' ? -1 : 1;
  const mtm = mark === null ? 0 : dir * (mark - leg.entry) * shares;

  const g = solveGreeks(midOf(q), chain, leg.strike, leg.optType, dateIst, minuteOfDay, venue);

  return {
    instrument: leg.instrument,
    strike: leg.strike,
    optType: leg.optType,
    side: leg.side,
    lots: leg.lots,
    lotSize: leg.lotSize,
    entry: leg.entry,
    openedByEngine: leg.openedByEngine,
    // Straight through, unexamined: the stamp is the STORED leg's fact, and the
    // mark has no business deciding which lean a leg belongs to.
    leanId: leg.leanId,
    iv: g === null ? null : g.iv,
    delta: g === null ? 0 : Math.abs(g.delta),
    gamma: g === null ? 0 : g.gamma,
    // Raw, unsigned by side — the CONTRACT's theta and vega, like `gamma` and
    // unlike the abs()'d `delta` only because Black-76 already hands both back
    // in the sign a trader expects (theta ≤ 0, vega ≥ 0, both wings). The 0 on
    // the null branch is the same zero-init as above: the flag is the answer.
    theta: g === null ? 0 : g.theta,
    vega: g === null ? 0 : g.vega,
    hasGreeks: g !== null,
    mtm,
    exit: q,
  };
}

/**
 * The full greek set of a strike we do not hold — the sizing input for "what
 * would this candidate actually do to the book".
 *
 * WIDER THAN `StrikeGreekReader`, deliberately: that reader is the parity
 * seam (`EngineInputs.strikeGreeksOverride`) and the Python fixtures carry
 * only a delta and a gamma, so it stays at two. Callers that want `iv`,
 * `theta` or `vega` must call this function directly rather than go through
 * `greekReader`, which may be answering off recorded rows.
 *
 * `null`, with NO fallback, whenever the answer is not measurable: the chain
 * does not carry the strike, that wing has no book, or the mid does not imply
 * a volatility (a quote at or under discounted intrinsic, or above the model
 * price at the solver's vol ceiling). Python substituted `0.30` here and sized
 * real packages off it; the replacement rule is that an unpriceable strike is
 * simply not a candidate (spec §5).
 *
 * The delta is signed by wing — see the file header.
 */
export function strikeGreeks(
  chain: ChainSnap,
  strike: number,
  optType: OptType,
  dateIst: string,
  minuteOfDay: number,
  venue: VenueSpec = NSE,
): { iv: number; delta: number; gamma: number; theta: number; vega: number } | null {
  const row = chain.strikes.find((s) => Math.abs(s.strike - strike) <= STRIKE_EPS);
  if (row === undefined) return null;
  const q = optType === 'CE' ? row.ce : row.pe;
  if (q === null) return null;

  const g = solveGreeks(midOf(q), chain, strike, optType, dateIst, minuteOfDay, venue);
  if (g === null) return null;
  return { iv: g.iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega };
}

/**
 * The price a fresh SALE of this contract would COLLECT — the bid, because that
 * is the side a seller crosses into (spec §6's "sell sizing off the bid").
 *
 * `pricing: 'parity'` reproduces Python's single mid-or-LTP float instead
 * (`_chain_price` read one `price` per row and no rule ever knew which side of
 * a spread it was standing on), because the recycle arm sizes its package off
 * this number — `want = ⌊fund / (px × lotSize)⌋` — and a bid-side read would
 * re-price every recorded board.
 *
 * `null` when that side has never been seen; the caller's package then does not
 * form, which is the honest answer and not a zero.
 */
export function sellPrice(q: Quote, pricing: PricingMode): number | null {
  return pricing === 'parity' ? midOf(q) : q.bid;
}

/**
 * WHAT THIS CONTRACT IS WORTH WHEN ITS OWN BOOK CANNOT BE BELIEVED — the maker
 * quote's price (spec §8, "no liquid candidate").
 *
 * The liquidity gate refuses a strike whose book is one-sided, too wide or too
 * old (`shed.ts` §4), and the desk still wants to sell it — so it QUOTES rather
 * than crossing, and the quote has to come from a model rather than from the
 * book that was just refused. This is that model: Black-76 at the chain's own
 * forward, the desk's own rate, the desk's own tenor.
 *
 * THE VOLATILITY IS THE CHAIN'S, NOT A CONSTANT. It is solved off the target
 * strike's own mid when that mid implies one — a stale or wide book still
 * carries a volatility, and it is this contract's own — and otherwise off the
 * NEAREST strike on the SAME WING whose mid does imply one. Scanning the same
 * wing is the whole of the approximation: a smile is smooth in strike, so the
 * neighbour's vol is the best statement available about this one, while the
 * other wing's is a different point on the surface. A flat guess (Python's
 * `0.30`-shaped stand-in) is exactly what this migration exists to delete.
 *
 * `null` when NOTHING on that wing implies a volatility. That is not a fallback
 * position — it means the chain is unpriced, `shed.ts` had no candidate to size
 * in the first place, and there is nothing to quote. The caller holds and says
 * so; it must never quote a number this function could not measure.
 *
 * NOT tick-rounded: the tick is a property of the CONTRACT (the instrument
 * master's `tick_size`), which this package deliberately does not know about.
 * The caller floors it.
 */
export function theoreticalPrice(
  chain: ChainSnap,
  strike: number,
  optType: OptType,
  dateIst: string,
  minuteOfDay: number,
  venue: VenueSpec = NSE,
): number | null {
  const base = {
    future: chain.spot,
    strike,
    t: yearFrac(dateIst, chain.expiry, minuteOfDay, venue),
    rate: rateOf(venue),
    type: optType,
  } as const;

  // Nearest first, and the target strike itself is distance 0 — so its own book
  // wins whenever it implies a vol at all, and only then does the scan widen.
  const wing = chain.strikes
    .map((row) => ({ strike: row.strike, q: optType === 'CE' ? row.ce : row.pe }))
    .sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike));

  for (const row of wing) {
    if (row.q === null) continue;
    const mid = midOf(row.q);
    if (mid === null) continue;
    const iv = b76ImpliedVol(mid, { ...base, strike: row.strike });
    if (iv === null) continue;
    const price = b76Price({ ...base, vol: iv });
    return price > 0 ? price : null;
  }
  return null;
}

/**
 * How THIS mark reads a strike greek: the fixture's recorded rows under parity
 * when the caller supplied them, the engine's own Black-76 solve otherwise.
 *
 * The gate is `pricing`, not the presence of the override, and that is
 * deliberate — see `EngineInputs.strikeGreeksOverride`. A live book is steered
 * only off numbers this engine measured.
 */
export function greekReader(inputs: EngineInputs): StrikeGreekReader {
  const override = inputs.strikeGreeksOverride;
  if (inputs.pricing === 'parity' && override !== undefined) return override;
  const { chain, dateIst, minuteOfDay } = inputs;
  const venue = inputs.venue ?? NSE;
  return (strike, optType) => strikeGreeks(chain, strike, optType, dateIst, minuteOfDay, venue);
}

/**
 * The one Black-76 call site: mid → IV → greeks, or null the moment any step
 * cannot be taken. Both public greek paths route through here so a leg's
 * greeks and a candidate strike's greeks can never be computed at different
 * rates, forwards or tenors.
 */
function solveGreeks(
  mid: number | null,
  chain: ChainSnap,
  strike: number,
  optType: OptType,
  dateIst: string,
  minuteOfDay: number,
  venue: VenueSpec,
): { iv: number; delta: number; gamma: number; theta: number; vega: number } | null {
  if (mid === null) return null;
  const inputs = {
    future: chain.spot,
    strike,
    t: yearFrac(dateIst, chain.expiry, minuteOfDay, venue),
    rate: rateOf(venue),
    type: optType,
  } as const;
  const iv = b76ImpliedVol(mid, inputs);
  if (iv === null) return null;
  const g = b76Greeks({ ...inputs, vol: iv });
  // All four, not the two the recenter rules happen to read: `b76Greeks` has
  // already paid for theta and vega, and dropping them here is what forces a
  // later consumer to open a SECOND Black-76 call site — the drift this
  // function exists to make impossible.
  return { iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega };
}
