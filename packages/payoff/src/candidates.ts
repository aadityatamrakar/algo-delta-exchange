/**
 * THE ALPHABET A REPAIR IS SPELLED IN.
 *
 * `goals.ts` searches over plans; this file decides which single moves are even
 * allowed to appear in one. That division is the point: a search that generates
 * its own candidates inline ends up with the trading rules smeared across a beam
 * loop, where "is this strike liquid enough to sell" and "is this plan better
 * than that one" become the same code. Here they are two files, and this one has
 * no notion of better — only of PERMITTED.
 *
 * FOUR FAMILIES, and they are the four things a desk actually does to a book
 * that has gone wrong. They are the Python desk's own families
 * (`basket/candidates.py:126-300`, `sim/optimizer/generate.py:114+`) reduced to
 * their atoms: the Python emits whole packaged structures — verticals, ratios,
 * flies, combos — because its optimizer scores a flat list and never composes.
 * A beam search composes, so a vertical here is "sell one, buy one" found by the
 * search rather than a template written down in advance, and the ratios and
 * flies fall out of the same arithmetic. What is deliberately NOT ported is the
 * lot-size ladder (`_ADD_PREMIUM_LOTS`, `_VERTICAL_LOTS`): every move here is
 * ONE lot, and size comes from repeating a family across strikes. A search whose
 * branching factor multiplies strikes by lot counts spends its whole beam on
 * "the same trade, bigger".
 *
 * ─ DELTA IS THE ADMISSION TEST, NOT DISTANCE ────────────────────────────────
 *
 * Every band below is read off `StrikeInfo.delta`, which the caller computes
 * from the SOLVED chain IVs (`ivs.ts` → `b76Greeks`). Not off strike distance,
 * and not off a fixed number of strike steps the way the Python's `_step_out`
 * does. Two reasons, and both of them have burned this desk:
 *
 *   • A strike step is not a constant amount of risk. Six days from expiry a
 *     ₹20 step is two thirds of a standard deviation; thirty days out it is a
 *     fifth of one. "Three strikes out" sells a 0.05-delta wing in one tenor and
 *     a 0.30-delta near-the-money in the other, under one name.
 *   • The skew is real. A put three steps down and a call three steps up are not
 *     the same trade on any Indian single stock, and a step count cannot see the
 *     difference. A delta can.
 *
 * The bands are `|delta|`, so one number covers both wings.
 *
 *   ADD     0.15 … 0.35   premium worth collecting, far enough out to survive
 *                         an ordinary day. Below 0.15 the credit does not pay
 *                         for the margin; above 0.35 it is a directional bet.
 *   SHIFT   0.20 … 0.30   where a threatened short is re-struck TO. Tighter than
 *                         the add band on purpose: a roll is a second chance,
 *                         and landing it at 0.35 spends that chance immediately.
 *   HEDGE   ≤ 0.10        tail protection, cheap by construction.
 *
 * ─ AND THREE REFUSALS ───────────────────────────────────────────────────────
 *
 * A quote OLDER than `maxQuoteAgeMs` is not tradeable — in any family, including
 * as the landing strike of a shift. A wing that last printed at 09:20 still has
 * an LTP at 14:50 and it will price a plan beautifully; the operator finds out
 * at the broker. `ageMs: null` is stale too: "I do not know how old this is" is
 * not evidence of freshness.
 *
 * A row with NO DELTA cannot be banded and a row with NO PRICE cannot be filled,
 * so neither can be traded, in any family.
 *
 * `minCreditPerShare` gates SELLS ONLY. A 20-paise wing is worthless premium and
 * exactly the tail cap the repairer wants to be able to buy; a floor that
 * applied to both would leave it with nothing but expensive protection.
 *
 * Pure, deterministic and fail-soft, like the rest of the package: the output is
 * ordered by family then strike so that the search that consumes it enumerates
 * in one fixed order, and malformed input yields a shorter alphabet, never a
 * throw.
 *
 * ─ THE OBJECTIVE SEARCH'S ALPHABET (`planMoves`) ────────────────────────────
 *
 * The same four families under the same bands and refusals, plus three things
 * the trader-facing search needs and the repair menu does not:
 *
 *   A SIZE LADDER, 1 … `maxLotsPerMove` lots (at most 5). The refusal above
 *   still holds in spirit — the ladder is short and the objective search lets a
 *   plan open each contract ONCE, so the beam cannot spend itself on "the same
 *   trade, bigger" — but "neutralize 2 lots of delta" is unanswerable in one-lot
 *   atoms when the plan may only hold three moves. Sizes sit next to each other,
 *   ascending, inside each strike: the order stays strike-major.
 *
 *   THE FUTURE, both sides, at the same ladder, when there is a mark to fill it
 *   at. It sits after the hedges: opens before edits before exits still.
 *
 *   LIQUIDITY (spec R8). An open or a shift's landing strike needs a LIVE,
 *   TWO-SIDED quote whose spread is at most max(10% of mid, ₹1). An LTP is not
 *   a market: a strike with no bid will price a plan beautifully off its last
 *   print and then not fill. Closes and the exit half of a shift are the
 *   trader's OWN legs and are never refused for liquidity — getting out of a
 *   thin contract is still getting out; the search prices it at the mark and
 *   says so (`indicative-price`). With no quote source at all the rule cannot
 *   be judged and nothing is excluded by it; the search then flags every option
 *   fill as indicative. Contracts the bands admitted and liquidity turned away
 *   are COUNTED, so the card can say the menu is narrower than the chain.
 *
 * And `untouchable` legs — the ones the trader said to leave alone — are never
 * shifted or closed.
 */
import type { OptionType } from '@algomaker/greeks'
import type { PayoffLeg } from './legs.ts'
import type { Move } from './moves.ts'
import type { PlanOp, PlanQuote } from './objective-types.ts'

/**
 * The dials a repair search runs on. All rupee figures are PER SHARE except
 * `maxMarginAdd`, which is a whole-book rupee cap like every other margin figure
 * in this package.
 */
export interface RepairDials {
  /** Sell no closer than this `|delta|`. */
  readonly addDeltaMin: number
  /** Sell no further out than this `|delta|` — beyond it the credit is noise. */
  readonly addDeltaMax: number
  /** A re-struck short lands no closer than this `|delta|`. */
  readonly shiftDeltaMin: number
  /** …and no further out than this. */
  readonly shiftDeltaMax: number
  /** Buy protection only at this `|delta|` or less. */
  readonly hedgeDeltaMax: number
  /** Total hedge spend allowed, as a fraction of the book's OPEN credit. */
  readonly hedgeBudgetFrac: number
  /** A sell must fetch at least this much per share to be worth the margin. */
  readonly minCreditPerShare: number
  /** Rupees of extra margin a plan may consume. `null` = uncapped. */
  readonly maxMarginAdd: number | null
  /** Shares per lot. Every generated open is exactly one lot. */
  readonly lotSize: number
  /** Older than this and a quote is evidence about a market that has moved on. */
  readonly maxQuoteAgeMs: number
}

/**
 * The shipped dials, minus the one that is a property of the CONTRACT rather
 * than of the policy. There is no sane default lot size — 1 is wrong for every
 * instrument this desk trades — so the caller must supply it and a plan can
 * never be quietly sized in single shares.
 */
export const DEFAULT_REPAIR_DIALS: Omit<RepairDials, 'lotSize'> = Object.freeze({
  addDeltaMin: 0.15,
  addDeltaMax: 0.35,
  shiftDeltaMin: 0.2,
  shiftDeltaMax: 0.3,
  hedgeDeltaMax: 0.1,
  hedgeBudgetFrac: 0.2,
  minCreditPerShare: 1,
  maxMarginAdd: null,
  // The same window `ivs.ts` solves inside. Two different definitions of "fresh"
  // in one cockpit is how a strike gets an IV it is not allowed to trade on.
  maxQuoteAgeMs: 120_000,
})

/**
 * One tradeable contract, as the chain knows it.
 *
 * Every field is nullable because every one of them genuinely goes missing on a
 * live chain: a wing with no print has no `price`, a quote below discounted
 * intrinsic has no `iv` and therefore no `delta`, and a snapshot assembled from
 * a cache may not know how old a row is. `null` is never treated as a zero.
 */
export interface StrikeInfo {
  readonly strike: number
  readonly type: OptionType
  /** Per-share mark, rupees. `null` = the chain cannot price it. */
  readonly price: number | null
  /** Milliseconds since the quote was live. `null` = unknown, i.e. not fresh. */
  readonly ageMs: number | null
  /** Solved vol, decimal. Carried for provenance; the bands read `delta`. */
  readonly iv: number | null
  /** SIGNED Black-76 delta per share. The bands read `|delta|`. */
  readonly delta: number | null
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function isType(v: unknown): v is OptionType {
  return v === 'CE' || v === 'PE'
}

/** A dial we can actually band on, or the default when the caller sent junk. */
function dial(v: unknown, fallback: number): number {
  return finite(v) ?? fallback
}

/**
 * A chain row that is tradeable AT ALL: real strike, real type, a price above
 * zero, a delta to band it by, and an age inside the window.
 *
 * A NEGATIVE age is fresh (clock skew between the feed and the caller is normal
 * and is not evidence of staleness), matching `ivs.ts`.
 */
interface Quote {
  readonly strike: number
  readonly type: OptionType
  readonly price: number
  readonly absDelta: number
}

function quoteOf(s: StrikeInfo, maxAgeMs: number): Quote | null {
  if (s === null || typeof s !== 'object') return null
  const strike = finite(s.strike)
  const price = finite(s.price)
  const delta = finite(s.delta)
  const age = finite(s.ageMs)
  if (strike === null || !isType(s.type) || price === null || delta === null) return null
  if (!(price > 0) || !(strike > 0)) return null
  // `null` age is stale: unknown is not fresh. See the header.
  if (age === null || age > maxAgeMs) return null
  return { strike, type: s.type, price, absDelta: Math.abs(delta) }
}

/** Ascending by strike, then calls before puts — a total order, so no ties. */
function byStrikeThenType(a: Quote, b: Quote): number {
  if (a.strike !== b.strike) return a.strike - b.strike
  if (a.type === b.type) return 0
  return a.type === 'CE' ? -1 : 1
}

/**
 * Every single move the repairer is allowed to consider on this book and this
 * chain, ordered by family and then by strike.
 *
 * ONE LOT per open, SIGNED: an add is `-lotSize` (a sell, collecting premium)
 * and a hedge is `+lotSize` (a buy). A shift carries the leg's own size, which
 * is `applyMoves`'s job and not expressible here — that is why a `lotSize` of
 * zero suppresses adds and hedges but leaves shifts and closes standing.
 *
 * Every leg gets a close, INCLUDING legs nothing else in this file can touch
 * (futures, legs with no strike). Whether that close can actually be priced is
 * `applyMoves`'s call, made against the same chain the plan is scored on; a
 * generator that pre-judged it would be a second, quieter copy of that rule.
 */
export function atomicMoves(
  legs: readonly PayoffLeg[],
  strikes: readonly StrikeInfo[],
  dials: RepairDials,
): readonly Move[] {
  try {
    return alphabet(legs, strikes, dials, REPAIR_SHAPE).moves
  } catch {
    // Unreachable by design; kept because this runs on every mark of every open
    // book and one malformed chain row must cost the panel its suggestions, not
    // its render.
    return []
  }
}

/** What the objective search asks of the alphabet, on top of the repair dials. See the header. */
export interface PlanMoveRules {
  /** The families a plan may use. 'close' only when the trader's request allowed it (spec R6). */
  readonly ops: readonly PlanOp[]
  /** Opens and futures are offered at 1 … this many lots. Clamped to 1–5. */
  readonly maxLotsPerMove: number
  /** What a `future` move fills at. `null` (or unusable) = no future moves. */
  readonly futureMark: number | null
  /** Leg ids no shift or close may touch. */
  readonly untouchable: readonly string[]
  /** The live quote per contract (spec R8). Absent = liquidity cannot be judged, nothing is refused for it. */
  readonly quoteOf?: (strike: number, type: OptionType) => PlanQuote | null
}

/** The objective search's alphabet, and what liquidity cost it. */
export interface PlanAlphabet {
  readonly moves: readonly Move[]
  /** Contracts the delta bands admitted for an open or a shift's landing that R8 turned away. */
  readonly illiquid: number
}

/** The ladder's ceiling, from the spec (R7): a plan is never "the same trade, five times bigger" plus. */
const MAX_LOTS_PER_MOVE = 5

/** Spread tolerance on the ₹1 / 10% test, so a quote exactly on the limit is inside it. */
const SPREAD_EPS = 1e-9

/**
 * Spec R8: a live, two-sided quote whose spread is at most max(10% of mid, ₹1).
 * `stale` must be exactly `false` — unknown freshness is stale, as everywhere in
 * this file. A crossed quote (ask below bid) is a broken quote, not a cheap one.
 */
export function liquidQuote(q: PlanQuote | null | undefined): boolean {
  if (q === null || typeof q !== 'object') return false
  if (q.stale !== false) return false
  const bid = finite(q.bid)
  const ask = finite(q.ask)
  if (bid === null || ask === null || !(bid > 0) || !(ask >= bid)) return false
  const mid = (bid + ask) / 2
  return ask - bid <= Math.max(0.1 * mid, 1) + SPREAD_EPS
}

/**
 * The objective search's alphabet: `atomicMoves`' families under the same dials,
 * with the size ladder, the future, the liquidity rule and the untouchable legs
 * (see the header). `dials.lotSize` is the lot every size is a multiple of.
 * Fail-soft: garbage in is a shorter alphabet, never a throw.
 */
export function planMoves(
  legs: readonly PayoffLeg[],
  strikes: readonly StrikeInfo[],
  dials: RepairDials,
  rules: PlanMoveRules,
): PlanAlphabet {
  try {
    const maxLots = Math.max(1, Math.min(MAX_LOTS_PER_MOVE, Math.trunc(finite(rules?.maxLotsPerMove) ?? 1)))
    const sizes = Array.from({ length: maxLots }, (_, i) => i + 1)
    const ops = new Set<PlanOp>(Array.isArray(rules?.ops) ? rules.ops : [])
    const mark = finite(rules?.futureMark)
    const lot = Math.trunc(dial(dials?.lotSize, 0))
    const futures = ops.has('future') && mark !== null && mark > 0 && lot > 0 ? [...sizes.map((n) => -n).reverse(), ...sizes] : []
    const quoteFn = rules?.quoteOf
    const liquid =
      typeof quoteFn === 'function'
        ? (strike: number, type: OptionType): boolean => {
            try {
              return liquidQuote(quoteFn(strike, type))
            } catch {
              return false
            }
          }
        : () => true
    const untouchable = new Set(
      (Array.isArray(rules?.untouchable) ? rules.untouchable : []).filter((s): s is string => typeof s === 'string'),
    )
    return alphabet(legs, strikes, dials, { sizes, liquid, ops, futures, untouchable })
  } catch {
    return { moves: [], illiquid: 0 }
  }
}

/** How an alphabet is shaped: the repair menu's (one lot, no futures, everything) or the objective search's. */
interface Shape {
  /** Lots per open, ascending. */
  readonly sizes: readonly number[]
  /** Spec R8 for an open or a shift's landing. */
  readonly liquid: (strike: number, type: OptionType) => boolean
  /** The families to emit; `null` = all four of the repair menu's. */
  readonly ops: ReadonlySet<PlanOp> | null
  /** Signed lots of the future, ascending; empty = none. */
  readonly futures: readonly number[]
  readonly untouchable: ReadonlySet<string>
}

const REPAIR_SHAPE: Shape = Object.freeze({
  sizes: Object.freeze([1]),
  liquid: () => true,
  ops: null,
  futures: Object.freeze([]),
  untouchable: new Set<string>(),
})

function alphabet(
  legs: readonly PayoffLeg[],
  strikes: readonly StrikeInfo[],
  dials: RepairDials,
  shape: Shape,
): PlanAlphabet {
  const maxAge = dial(dials?.maxQuoteAgeMs, DEFAULT_REPAIR_DIALS.maxQuoteAgeMs)
  const addMin = dial(dials?.addDeltaMin, DEFAULT_REPAIR_DIALS.addDeltaMin)
  const addMax = dial(dials?.addDeltaMax, DEFAULT_REPAIR_DIALS.addDeltaMax)
  const shiftMin = dial(dials?.shiftDeltaMin, DEFAULT_REPAIR_DIALS.shiftDeltaMin)
  const shiftMax = dial(dials?.shiftDeltaMax, DEFAULT_REPAIR_DIALS.shiftDeltaMax)
  const hedgeMax = dial(dials?.hedgeDeltaMax, DEFAULT_REPAIR_DIALS.hedgeDeltaMax)
  const minCredit = dial(dials?.minCreditPerShare, DEFAULT_REPAIR_DIALS.minCreditPerShare)
  const lot = Math.trunc(dial(dials?.lotSize, 0))
  const wants = (op: PlanOp): boolean => shape.ops === null || shape.ops.has(op)

  const book = (Array.isArray(legs) ? legs : []).filter(
    (l): l is PayoffLeg => l !== null && typeof l === 'object',
  )

  // The tradeable chain, de-duplicated on (strike, type) keeping the FIRST
  // row — a chain that quotes one contract twice is a feed defect, and picking
  // arbitrarily between the two would make the whole alphabet depend on
  // iteration order (`ivs.ts` resolves the same collision the same way).
  const seen = new Set<string>()
  const quotes: Quote[] = []
  for (const s of Array.isArray(strikes) ? strikes : []) {
    const q = quoteOf(s, maxAge)
    if (q === null) continue
    const key = `${q.strike}${q.type}`
    if (seen.has(key)) continue
    seen.add(key)
    quotes.push(q)
  }
  quotes.sort(byStrikeThenType)

  // Contracts a band admitted and R8 refused — counted once however many
  // families wanted them.
  const refused = new Set<string>()
  const liquid = (q: Quote): boolean => {
    if (shape.liquid(q.strike, q.type)) return true
    refused.add(`${q.strike}${q.type}`)
    return false
  }

  const adds: Move[] = []
  const hedges: Move[] = []
  if (lot > 0) {
    for (const q of quotes) {
      if (wants('add') && q.absDelta >= addMin && q.absDelta <= addMax && q.price >= minCredit && liquid(q)) {
        for (const n of shape.sizes) adds.push({ op: 'add', strike: q.strike, type: q.type, qty: -lot * n })
      }
      // Not `else`: the bands are the caller's, and a caller that overlaps
      // them means both — silently preferring one would hide the overlap.
      if (wants('hedge') && q.absDelta <= hedgeMax && liquid(q)) {
        for (const n of shape.sizes) hedges.push({ op: 'hedge', strike: q.strike, type: q.type, qty: lot * n })
      }
    }
  }

  // The future, ascending by signed size: sells first. Only offered when the
  // caller has a lot and a mark (`planMoves`); the repair menu has none.
  const futures: Move[] = shape.futures.map((n) => ({ op: 'future', qty: lot * n }))

  // A SHORT option only, and only FURTHER OTM: a call goes up, a put goes
  // down. Re-striking a short toward the money is not a repair, and re-striking
  // somebody's long hedge is a different decision from rolling a threatened
  // short — neither belongs in an alphabet the search will compose freely.
  const shifts: Move[] = []
  for (const leg of wants('shift') ? book : []) {
    if (leg.instrument !== 'option') continue
    const from = finite(leg.strike)
    const qty = finite(leg.qty)
    if (from === null || qty === null || qty >= 0 || !isType(leg.type)) continue
    if (typeof leg.id !== 'string' || leg.id === '') continue
    if (shape.untouchable.has(leg.id)) continue
    for (const q of quotes) {
      if (q.type !== leg.type) continue
      if (q.absDelta < shiftMin || q.absDelta > shiftMax) continue
      const further = leg.type === 'CE' ? q.strike > from : q.strike < from
      if (!further) continue
      if (!liquid(q)) continue
      shifts.push({ op: 'shift', legId: leg.id, toStrike: q.strike })
    }
  }
  // Source strike first so a book's rolls read together, then the landing
  // strike; the leg id breaks the tie two legs on one strike would leave.
  shifts.sort((a, b) => {
    if (a.op !== 'shift' || b.op !== 'shift') return 0
    const la = book.find((l) => l.id === a.legId)
    const lb = book.find((l) => l.id === b.legId)
    const ka = finite(la?.strike ?? null) ?? 0
    const kb = finite(lb?.strike ?? null) ?? 0
    if (ka !== kb) return ka - kb
    if (a.legId !== b.legId) return a.legId < b.legId ? -1 : 1
    return a.toStrike - b.toStrike
  })

  const closed = new Set<string>()
  const closes: Move[] = []
  for (const leg of wants('close') ? book : []) {
    if (typeof leg.id !== 'string' || leg.id === '' || closed.has(leg.id)) continue
    if (shape.untouchable.has(leg.id)) continue
    closed.add(leg.id)
    closes.push({ op: 'close', legId: leg.id })
  }
  closes.sort((a, b) => {
    if (a.op !== 'close' || b.op !== 'close') return 0
    const ka = finite(book.find((l) => l.id === a.legId)?.strike ?? null)
    const kb = finite(book.find((l) => l.id === b.legId)?.strike ?? null)
    // A strikeless leg (a future) sorts last: it has no place on the ladder.
    if (ka !== kb) return (ka ?? Infinity) - (kb ?? Infinity)
    return a.legId < b.legId ? -1 : a.legId > b.legId ? 1 : 0
  })

  // ADD, HEDGE, (FUTURE,) SHIFT, CLOSE — by construction rather than by a final
  // sort, since each family is already internally ordered. The order is part of
  // the contract `goals.ts` enumerates in: the search walks this array by index
  // and only ever extends a plan with a LATER index, so this line fixes which
  // permutation of a move set the beam ever sees, and with it the output. Opens
  // before edits before exits, the order a desk reaches for them.
  return { moves: [...adds, ...hedges, ...futures, ...shifts, ...closes], illiquid: refused.size }
}
