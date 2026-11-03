/**
 * THE EXPRESSION LAYER — which option to trade, on a chain the book already
 * knows it wants delta from.
 *
 * `tradableStrikes` is the liquidity filter (spec §7): a two-sided quote, an
 * age under `dl_quote_fresh_s`, and a spread no wider than
 * `max(dl_max_spread_pct × mid, dl_max_spread_abs)`. A ROW, not a wing, is the
 * unit of the answer — a strike whose call is unquotable is a strike the book
 * cannot form or unwind a structure at.
 *
 * `deltaBandStrike` walks OUTWARD FROM ATM for the first tradable strike whose
 * |delta| falls in a band, never a strike offset: the 24,250 call is 0.27
 * delta on Monday and 0.02 on expiry eve, so "sell two strikes out" is a
 * different trade every day while reading as a constant. `strikeGreeks`
 * returning `null` — unmeasurable, or a book too wide, stale or one-sided —
 * is not a candidate; there is no default delta anywhere behind this file.
 * Python's `0.30` substitution sized real packages, and it is the defect the
 * port exists to retire (spec §5).
 *
 * `debitUnit` and `creditUnit` are the two structures the hold-and-adjust
 * engine trades: a long-gamma debit pair for a trending open, a short-gamma
 * credit pair (short plus its wing) for a quiet one. LEG ORDER IS A SAFETY
 * PROPERTY, not a style choice — `debitUnit` BUYS its long before it sells its
 * short, `creditUnit` BUYS its wing before it sells the short it protects. The
 * book must never be naked, not even for the instant between two fills — and
 * that instant is exactly when an index gaps. A unit that cannot form BOTH
 * legs returns `null` rather than the half of itself that happens to be
 * available.
 *
 * PURE, like the rest of the engine: no clock, no feed. `nowMs`, `dateIst` and
 * `minuteOfDay` are arguments so a fixture can replay a session that is over.
 */

import type { Dials } from '../dials.ts';
import { strikeGreeks } from '../marking.ts';
import type {
  ChainSnap,
  EngineAction,
  OptType,
  Quote,
  StrikeQuote,
} from '../types.ts';

/**
 * Both units below only ever emit `'open'`s — a unit is a fresh pair or
 * spread, never a close or a resize — so their return type says that rather
 * than the full `EngineAction` union, which a caller could otherwise narrow
 * onto `.side`/`.optType` and find neither on a `'close'` it can never hold.
 */
type OpenAction = Extract<EngineAction, { op: 'open' }>;

/** Strike equality, the same tolerance `marking.ts` matches a chain row on. */
const STRIKE_EPS = 1e-6;

/**
 * The strikes whose books are worth trading against, spec §7's liquidity
 * filter: a two-sided quote, an age under `dl_quote_fresh_s`, and a spread no
 * wider than `max(dl_max_spread_pct × mid, dl_max_spread_abs)`.
 *
 * The ABSOLUTE floor is not belt-and-braces: 2% of a ₹1 option is two paise,
 * which no index option has ever traded at, so a percentage gate alone would
 * silently delete the entire far wing — which is exactly where the credit
 * unit's protection lives.
 *
 * A ROW, not a wing, is the unit of the answer. A strike whose call is
 * unquotable is a strike the book cannot form or unwind a structure at, and
 * handing back a half-usable row would push that judgement onto every caller.
 * The conservative reading is the safe one here, and it is what the plan's
 * test pins.
 *
 * `midOf` is deliberately NOT used: it falls back to the LTP for a one-sided
 * book, and a book with one side is precisely what this gate exists to refuse.
 */
export function tradableStrikes(
  chain: ChainSnap,
  dials: Dials,
  nowMs: number,
): readonly StrikeQuote[] {
  return chain.strikes.filter(
    (row) => liquid(row.ce, dials, nowMs) && liquid(row.pe, dials, nowMs),
  );
}

function liquid(quote: Quote | null, dials: Dials, nowMs: number): boolean {
  if (quote === null) return false;
  const { bid, ask } = quote;
  if (bid === null || ask === null) return false;

  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return false;

  // A quote stamped in the FUTURE is a clock skew, not a stale book: the age
  // is negative and passes. Feed death is the market-data health check's to
  // catch, the same division `shed.ts` draws.
  if (nowMs - quote.asOf > dials.dl_quote_fresh_s * 1000) return false;

  const limit = Math.max(dials.dl_max_spread_pct * mid, dials.dl_max_spread_abs);
  if (!(limit > 0)) return false;   // both dials zeroed: nothing can pass
  return ask - bid <= limit;
}

/** The listed strike closest to the forward. `null` only on an empty chain. */
function atmStrike(chain: ChainSnap): number | null {
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const row of chain.strikes) {
    const gap = Math.abs(row.strike - chain.spot);
    if (gap < bestGap) {
      bestGap = gap;
      best = row.strike;
    }
  }
  return best;
}

/** Further from the money than `ref`, on `ref`'s own side. */
function furtherOtm(strike: number, ref: number, optType: OptType): boolean {
  return optType === 'CE' ? strike > ref + STRIKE_EPS : strike < ref - STRIKE_EPS;
}

/**
 * The band walk, with an optional extra constraint on which strikes may be
 * considered — how a unit pins its second leg strictly beyond its first
 * instead of discovering an inverted spread after the fact.
 *
 * The walk is OUTWARD FROM ATM because a band is one-sided in delta but not in
 * strike: 0.55-0.65 is the ITM side of a call ladder and the OTM side of a put
 * one, and the nearest qualifying strike is the liquid one either way. Equal
 * distances are ordered by strike so the answer is deterministic; in practice
 * the two sides of a tie are on opposite sides of 0.50 delta and only one can
 * be in a band this narrow.
 *
 * Freshness is measured against `chain.asOf` — the snapshot's own stamp is the
 * clock INSIDE it, and what this catches is a row lagging the rest of the
 * board. Whether the whole snapshot is too old to decide on is
 * `decideDeltaLean`'s `dl_spot_stale_s` gate, one level up, and duplicating it
 * here would make a pure function need a clock.
 */
function bandStrike(
  chain: ChainSnap,
  optType: OptType,
  lo: number,
  hi: number,
  dateIst: string,
  minuteOfDay: number,
  dials: Dials,
  accept: (strike: number) => boolean = () => true,
): number | null {
  if (!(chain.step > 0)) return null;
  const atm = atmStrike(chain);
  if (atm === null) return null;

  // `dl_min_strike_gap` in STEPS, so a band never lands on ATM by accident —
  // which matters most on expiry day, when every strike is a steep delta.
  const minGap = Math.max(0, dials.dl_min_strike_gap) * chain.step;

  const rows = tradableStrikes(chain, dials, chain.asOf)
    .filter((r) => Math.abs(r.strike - atm) + STRIKE_EPS >= minGap && accept(r.strike))
    .slice()
    .sort((a, b) => {
      const da = Math.abs(a.strike - atm);
      const db = Math.abs(b.strike - atm);
      return da === db ? a.strike - b.strike : da - db;
    });

  for (const row of rows) {
    const g = strikeGreeks(chain, row.strike, optType, dateIst, minuteOfDay);
    if (g === null) continue;   // unmeasurable, and therefore not a candidate
    const mag = Math.abs(g.delta);
    if (mag >= lo && mag <= hi) return row.strike;
  }
  return null;
}

/**
 * The first tradable strike whose |delta| falls in `[lo, hi]`, walking outward
 * from ATM, or `null` if the ladder holds none.
 *
 * `null` is the whole contract: "nearest miss" is how a book ends up 40% long
 * of its target while every individual decision looks defensible.
 *
 * `accept` is `bandStrike`'s own extra constraint, threaded out to the one
 * caller outside this file. It DEFAULTS TO ACCEPT-ALL, so `debitUnit`,
 * `creditUnit` and every other caller read exactly as they did. The one use is
 * `decide.ts`'s sideways SALE, which may not land on a strike the book already
 * holds long: an opposite-side fill on a held instrument is netted downstream
 * into a partial close of that leg, and this engine closes nothing before the
 * close (D2).
 */
export function deltaBandStrike(
  chain: ChainSnap,
  optType: OptType,
  lo: number,
  hi: number,
  dateIst: string,
  minuteOfDay: number,
  dials: Dials,
  accept: (strike: number) => boolean = () => true,
): number | null {
  return bandStrike(chain, optType, lo, hi, dateIst, minuteOfDay, dials, accept);
}

/**
 * The trend structure: buy 0.55-0.65 delta, sell 0.20-0.30 delta of the same
 * wing further out. About +0.35 delta a pair, theta near zero, long gamma at
 * spot, and a bounded loss (spec §7).
 *
 * `side` is the DELTA the unit expresses, the same vocabulary as
 * `RuleState.dlOpenSide`: `'up'` is the call spread, `'down'` the put one.
 *
 * ONE lot a leg. "One base unit of delta is expressed as however many debit
 * pairs reach it" — the repetition belongs to the caller, which is the only
 * thing that knows the margin and the order budget the repetition has to fit
 * inside.
 *
 * The long leg is emitted FIRST and the short is constrained to strikes
 * strictly further OTM than it, so the pair can never come back inverted and
 * the book is never short a leg it has not yet covered.
 */
export function debitUnit(
  chain: ChainSnap,
  side: 'up' | 'down',
  dials: Dials,
  dateIst: string,
  minuteOfDay: number,
): readonly OpenAction[] | null {
  const optType: OptType = side === 'up' ? 'CE' : 'PE';

  const long = bandStrike(
    chain, optType, dials.dl_long_delta_lo, dials.dl_long_delta_hi, dateIst, minuteOfDay, dials,
  );
  if (long === null) return null;

  const short = bandStrike(
    chain, optType, dials.dl_short_delta_lo, dials.dl_short_delta_hi, dateIst, minuteOfDay, dials,
    (k) => furtherOtm(k, long, optType),
  );
  if (short === null) return null;

  return [
    { op: 'open', strike: long, optType, side: 'Buy', lots: 1 },
    { op: 'open', strike: short, optType, side: 'Sell', lots: 1 },
  ];
}

/**
 * The quiet-regime structure: sell no richer than `dl_credit_short_delta_max`
 * (0.30) and at least `dl_min_strike_gap` strikes OTM, and buy a wing of
 * `dl_wing_delta` (0.10) or thinner beyond it.
 *
 * `side` is the DELTA the unit expresses, exactly as in `debitUnit`: `'up'` is
 * the short PUT spread below spot, `'down'` the short call spread above. Two
 * calls, one each way, are the quiet regime's strangle.
 *
 * Both bands are read as CEILINGS — `dl_credit_short_delta_max` says so in its
 * name, and the wing follows it, because a wing richer than 0.10 delta eats
 * the credit the unit exists to collect while the walk outward already
 * guarantees it is the NEAREST strike that thin. At 12% vol with a week to run
 * that lands further out than the spec's "3 to 4 strikes"; that is the delta
 * band doing its job, not a miss.
 *
 * The wing is emitted FIRST, and it is NOT optional (D3): for a quiet open the
 * hedge IS the strangle's two wings, and nothing removes a hedge before the
 * close. With no wing available on the ladder the unit does not form AT ALL —
 * selling the short and finding the wing unbuyable afterwards is the one
 * outcome the ordering rule exists to prevent.
 */
export function creditUnit(
  chain: ChainSnap,
  side: 'up' | 'down',
  lots: number,
  dials: Dials,
  dateIst: string,
  minuteOfDay: number,
): readonly OpenAction[] | null {
  if (!Number.isInteger(lots) || lots <= 0) return null;

  const optType: OptType = side === 'up' ? 'PE' : 'CE';
  const atm = atmStrike(chain);
  if (atm === null) return null;

  const short = bandStrike(
    chain, optType, 0, dials.dl_credit_short_delta_max, dateIst, minuteOfDay, dials,
    (k) => furtherOtm(k, atm, optType),
  );
  if (short === null) return null;

  const sell: EngineAction = { op: 'open', strike: short, optType, side: 'Sell', lots };

  const wing = bandStrike(
    chain, optType, 0, dials.dl_wing_delta, dateIst, minuteOfDay, dials,
    (k) => furtherOtm(k, short, optType),
  );
  if (wing === null) return null;

  return [{ op: 'open', strike: wing, optType, side: 'Buy', lots }, sell];
}
