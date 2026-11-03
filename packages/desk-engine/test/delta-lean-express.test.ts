/**
 * THE EXPRESSION LAYER: WHICH OPTION, NOT HOW MANY OF THE ONE WE ALWAYS TRADE.
 *
 * The controller says "+0.35 delta-lots". This module decides what to send.
 * Four things would otherwise pass silently, and each has its own block:
 *
 *   1. BEST FIT, NOT BIGGEST HAMMER. A 0.35 excess is met by one lot of a
 *      0.35-delta option. Waiting for a full ATM lot overshoots to 0.55 and
 *      then needs undoing — two spreads paid to end up where one would have.
 *      The tie between BUYING a call and SELLING a put is broken by theta,
 *      which is the entire mechanism keeping this book from being a naked
 *      long-gamma bleed.
 *   2. BANDS, NOT OFFSETS. `dl_long_delta_lo/hi` is 0.55-0.65 because the same
 *      strike is a completely different delta on Monday and on expiry eve. A
 *      "two strikes OTM" rule reads as 0.30 delta on Monday and 0.05 on
 *      Thursday, and sizes a real package off the difference.
 *   3. LEG ORDER IS A SAFETY PROPERTY. A debit unit BUYS before it sells; a
 *      credit unit buys its WING before it sells the short. The book must
 *      never be naked, not even for the instant between two fills, because
 *      that instant is exactly when an index gaps.
 *   4. UNMEASURABLE IS NOT A CANDIDATE. `strikeGreeks` returning `null` and a
 *      wide/stale book are two different rejections, and BOTH end in "this
 *      strike is not traded" rather than in a default delta. Python's 0.30
 *      stand-in is the defect this whole port exists to retire.
 *
 * THE FIXTURE, hand-derivable and reused everywhere: a 41-strike NIFTY-shaped
 * ladder (23,000…25,000 by 50) around spot 24,000, lot 75, quoted so that each
 * MID is exactly the Black-76 price at vol 0.12 with seven days to run. Every
 * strike therefore solves back to 0.12 and its delta is the model's:
 *
 *   23,450 PE  |δ| 0.0802     23,750 PE  |δ| 0.2613     23,900 CE  δ 0.6016
 *   23,950 CE  δ  0.5525      24,000 CE  δ 0.5027       24,150 CE  δ 0.3565
 *   24,250 CE  δ  0.2689      24,300 CE  δ 0.2296       24,550 CE  δ 0.0876
 *
 * so the delta bands land: long CE 23,950 (0.5525, one step ITM), short CE
 * 24,250 (0.2689), credit short PE 23,750 (0.2613 — 23,800's 0.3040 is over
 * `dl_credit_short_delta_max`) and its wing PE 23,450 (0.0802 — 23,500's
 * 0.1010 is over `dl_wing_delta`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import { DEFAULT_DIALS, type Dials } from '../src/dials.ts'
import { RISK_FREE, strikeGreeks } from '../src/marking.ts'
import type { ChainSnap, EngineAction, OptType, Quote, StrikeQuote } from '../src/types.ts'
import {
  creditUnit,
  debitUnit,
  deltaBandStrike,
  tradableStrikes,
} from '../src/delta-lean/express.ts'

const DATE = '2026-09-15' // a Tuesday
const EXPIRY = '2026-09-22'
const MINUTE = 600 // 10:00 IST — seven WHOLE days out, so the minute is inert
const T7 = 7 / 365
const VOL = 0.12
const SPOT = 24_000
const STEP = 50
const LOT = 75
/** 2026-09-15 10:00 IST, as an epoch — a real instant, never `Date.now()`. */
const NOW = Date.UTC(2026, 8, 15, 4, 30)

const DIALS = DEFAULT_DIALS
const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })

const q = (bid: number, ask: number, asOf = NOW): Quote => ({ bid, ask, ltp: null, asOf })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so the
 * IV solve returns `VOL` and the greeks are the model's. `halfWidth` is the
 * half-spread as a fraction of that mid — 0.005 gives a 1% spread, inside
 * `dl_max_spread_pct` (2%) at every strike that is not being widened on
 * purpose. */
function bookAt(spot: number, strike: number, type: OptType, halfWidth = 0.005, asOf = NOW): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * (1 - halfWidth), px * (1 + halfWidth), asOf)
}

const LADDER = Array.from({ length: 41 }, (_, i) => 23_000 + i * STEP)

interface RowOver {
  readonly ce?: Quote | null
  readonly pe?: Quote | null
}

/** The ladder, with named rows replaced — `{ ce: null }` for a wing with no
 * book at all, a re-built `bookAt` for a wide or stale one. */
function chainOf(
  spot = SPOT,
  over: ReadonlyMap<number, RowOver> = new Map(),
  strikes: readonly number[] = LADDER,
): ChainSnap {
  return {
    symbol: 'NIFTY',
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: strikes.map((k) => {
      const row = over.get(k)
      return {
        strike: k,
        ce: row !== undefined && 'ce' in row ? (row.ce ?? null) : bookAt(spot, k, 'CE'),
        pe: row !== undefined && 'pe' in row ? (row.pe ?? null) : bookAt(spot, k, 'PE'),
      }
    }),
    asOf: NOW,
  }
}

const strikesOf = (rows: readonly StrikeQuote[]): number[] => rows.map((r) => r.strike)

type OpenAction = Extract<EngineAction, { op: 'open' }>

/** Narrow one leg of a unit to the `'open'` it must be. A unit that emitted a
 * close or a resize is a defect, not a different shape to read around — so
 * this asserts rather than widening the assertions that follow it. */
function opened(action: EngineAction | undefined): OpenAction {
  assert.ok(action !== undefined, 'the unit is missing a leg')
  assert.equal(action.op, 'open')
  return action as OpenAction
}

// ── tradableStrikes: a rejected strike is not a candidate at all ────────────

test('a wide or stale strike is not a candidate at all', () => {
  // 2% of mid or ₹1, whichever is LARGER; and a quote older than 3s.
  // 24,250 CE mids at 64.98, so the gate is max(₹1.30, ₹1) = ₹1.30.
  const wide = new Map([[24_250, { ce: bookAt(SPOT, 24_250, 'CE', 0.05) }]]) // ₹6.50 spread
  assert.equal(strikesOf(tradableStrikes(chainOf(SPOT, wide), DIALS, NOW)).includes(24_250), false)

  const stale = new Map([[24_250, { ce: bookAt(SPOT, 24_250, 'CE', 0.005, NOW - 10_000) }]])
  assert.equal(strikesOf(tradableStrikes(chainOf(SPOT, stale), DIALS, NOW)).includes(24_250), false)

  // A one-sided book and a wing with no book at all are the same rejection.
  const oneSided = new Map([[24_250, { ce: { bid: null, ask: 65.3, ltp: 65, asOf: NOW } }]])
  assert.equal(strikesOf(tradableStrikes(chainOf(SPOT, oneSided), DIALS, NOW)).includes(24_250), false)
  const noBook = new Map([[24_250, { ce: null }]])
  assert.equal(strikesOf(tradableStrikes(chainOf(SPOT, noBook), DIALS, NOW)).includes(24_250), false)

  // The gate is not rejecting everything: the untouched ladder passes whole.
  assert.equal(tradableStrikes(chainOf(), DIALS, NOW).length, LADDER.length)
})

test('the ₹1 floor keeps the cheap strikes tradable, which 2% alone would not', () => {
  // The dial's own rationale: 2% of a ₹1 option is 2 paise, which no index
  // option trades at. 25,000 CE mids at ₹0.93 — a 90-paise spread is 97% of
  // mid and still inside the ₹1 absolute floor.
  const thin = new Map([[25_000, { ce: q(0.5, 1.4) }]])
  assert.equal(strikesOf(tradableStrikes(chainOf(SPOT, thin), DIALS, NOW)).includes(25_000), true)
  // ₹1.20 clears the floor and 2% of mid, so it goes.
  const tooThin = new Map([[25_000, { ce: q(0.4, 1.6) }]])
  assert.equal(strikesOf(tradableStrikes(chainOf(SPOT, tooThin), DIALS, NOW)).includes(25_000), false)
})

test('a quote stamped in the future is a clock problem, not a stale book', () => {
  const ahead = new Map([[24_250, { ce: bookAt(SPOT, 24_250, 'CE', 0.005, NOW + 5_000) }]])
  assert.equal(strikesOf(tradableStrikes(chainOf(SPOT, ahead), DIALS, NOW)).includes(24_250), true)
})

// ── deltaBandStrike: the band, the gap, and the honest null ─────────────────

test('the delta band picks the strike by delta, not by offset', () => {
  const chain = chainOf()
  // 23,950 is δ 0.5525 and one step ITM; 23,900 is 0.6016. Nearest in band wins.
  assert.equal(deltaBandStrike(chain, 'CE', 0.55, 0.65, DATE, MINUTE, DIALS), 23_950)
  // The short band 0.20-0.30 lands FIVE strikes out at this vol — which is the
  // whole point: a "2-3 strikes OTM" rule would have sold 0.31 delta here and
  // 0.05 on expiry eve.
  assert.equal(deltaBandStrike(chain, 'CE', 0.2, 0.3, DATE, MINUTE, DIALS), 24_250)
  // Puts walk DOWN to the same |δ| band.
  assert.equal(deltaBandStrike(chain, 'PE', 0.2, 0.3, DATE, MINUTE, DIALS), 23_750)
})

test('the minimum strike gap keeps a band off ATM', () => {
  const chain = chainOf()
  // With the gap at 2 steps the 0.55-0.65 band cannot take 23,950 (one step)
  // and moves out to 23,900 (δ 0.6016). On expiry day, when every strike is a
  // steep delta, this is what stops the band landing on ATM by accident.
  assert.equal(deltaBandStrike(chain, 'CE', 0.55, 0.65, DATE, MINUTE, dialsOf({ dl_min_strike_gap: 2 })), 23_900)
  // A gap wider than the band's own reach has no answer — and says so.
  assert.equal(deltaBandStrike(chain, 'CE', 0.55, 0.65, DATE, MINUTE, dialsOf({ dl_min_strike_gap: 8 })), null)
})

test('an empty band returns null, never the nearest miss', () => {
  // The richest call on the ladder is 23,000 at δ 0.9937. Nothing is in
  // [0.995, 1.0], and "close enough" is how a book ends up 40% long of target.
  assert.equal(deltaBandStrike(chainOf(), 'CE', 0.995, 1, DATE, MINUTE, DIALS), null)
})

test('a strike whose IV does not solve is not a candidate — never a default delta', () => {
  // 23,950 CE is ₹50 in the money; a tight, fresh 1.00/1.50 book is BELOW
  // discounted intrinsic, so the solve fails. It passes the LIQUIDITY gate,
  // which is the point: the two rejections are different and both are final.
  const broken = new Map([[23_950, { ce: q(1, 1.5) }]])
  const chain = chainOf(SPOT, broken)
  assert.equal(strikesOf(tradableStrikes(chain, DIALS, NOW)).includes(23_950), true)
  assert.equal(strikeGreeks(chain, 23_950, 'CE', DATE, MINUTE), null)
  // …so the band steps past it to 23,900 rather than substituting anything.
  assert.equal(deltaBandStrike(chain, 'CE', 0.55, 0.65, DATE, MINUTE, DIALS), 23_900)
})

test('`accept` narrows the walk, and its default lets every caller alone', () => {
  /**
   * The parameter exists for ONE caller: `decide.ts`'s adjustment, which may
   * not land on a strike the book already holds ON THE OTHER SIDE — an
   * opposite-side fill on a held instrument is netted downstream into a
   * partial CLOSE of that leg, and this engine closes nothing before the close
   * (D2). Both directions: a sale onto a held long takes the day's position
   * off, and a pyramid onto the drifted hedge takes the hedge off.
   *
   * The default is accept-all, so `debitUnit`, `creditUnit` and every existing
   * call read exactly as they did; the tests above are that half of it.
   */
  const chain = chainOf()
  assert.equal(deltaBandStrike(chain, 'CE', 0.55, 0.65, DATE, MINUTE, DIALS), 23_950)
  // Refused, so the walk carries on outward — and 23,900 (δ 0.609) is next.
  assert.equal(
    deltaBandStrike(chain, 'CE', 0.55, 0.65, DATE, MINUTE, DIALS, (k) => k !== 23_950),
    23_900,
  )
  // A predicate that refuses the whole band is an honest null, not a fallback.
  assert.equal(deltaBandStrike(chain, 'CE', 0.55, 0.65, DATE, MINUTE, DIALS, () => false), null)
})

test('an untradable strike is skipped by the band too', () => {
  const wide = new Map([[24_250, { ce: bookAt(SPOT, 24_250, 'CE', 0.05) }]])
  assert.equal(deltaBandStrike(chainOf(SPOT, wide), 'CE', 0.2, 0.3, DATE, MINUTE, DIALS), 24_300)
})

// ── the two units, and the leg order that keeps the book covered ────────────

test('a debit unit buys near and sells 2-3 strikes out, long leg first', () => {
  const u = debitUnit(chainOf(24_000), 'up', DIALS, DATE, MINUTE)
  assert.ok(u !== null)
  assert.equal(u.length, 2)
  const [long, short] = [opened(u[0]), opened(u[1])]
  assert.equal(long.side, 'Buy') // never naked, even for an instant
  assert.equal(short.side, 'Sell')
  assert.ok(short.strike > long.strike)
  assert.deepEqual(u[0], { op: 'open', strike: 23_950, optType: 'CE', side: 'Buy', lots: 1 })
  assert.deepEqual(u[1], { op: 'open', strike: 24_250, optType: 'CE', side: 'Sell', lots: 1 })
})

test('a debit unit leaning DOWN is the same structure on the put ladder', () => {
  const u = debitUnit(chainOf(24_000), 'down', DIALS, DATE, MINUTE)
  assert.ok(u !== null)
  const [long, short] = [opened(u[0]), opened(u[1])]
  assert.equal(long.side, 'Buy')
  assert.equal(short.side, 'Sell')
  assert.equal(long.optType, 'PE')
  // 24,100 PE is |δ| 0.5948 (24,050's 0.5459 misses the band); the short is
  // 23,750 PE at 0.2613. OTM for a put is DOWN, so the sold strike is lower.
  assert.equal(long.strike, 24_100)
  assert.equal(short.strike, 23_750)
  assert.ok(short.strike < long.strike)
})

test('a debit unit refuses rather than sending half of itself', () => {
  // A ladder that stops at 24,100 carries no 0.20-0.30 call to sell. The
  // alternative to null is a naked long — or worse, an inverted spread.
  const short = LADDER.filter((k) => k <= 24_100)
  assert.equal(debitUnit(chainOf(SPOT, new Map(), short), 'up', DIALS, DATE, MINUTE), null)
})

test('a credit unit sells at least one strike out and buys its wing first', () => {
  const u = creditUnit(chainOf(24_000), 'up', 1, DIALS, DATE, MINUTE)
  assert.ok(u !== null)
  assert.equal(u.length, 2)
  const [wing, short] = [opened(u[0]), opened(u[1])]
  assert.equal(wing.side, 'Buy') // the wing, bought BEFORE the short is sold
  assert.equal(short.side, 'Sell')
  assert.ok(Math.abs(short.strike - 24_000) >= DIALS.dl_min_strike_gap * STEP)
  // 'up' is the DELTA the unit expresses, exactly as it is for debitUnit and
  // for RuleState.dlLeanSide: a short put spread below spot is +delta.
  assert.deepEqual(u[0], { op: 'open', strike: 23_450, optType: 'PE', side: 'Buy', lots: 1 })
  assert.deepEqual(u[1], { op: 'open', strike: 23_750, optType: 'PE', side: 'Sell', lots: 1 })
  assert.ok(wing.strike < short.strike, 'the wing is further OTM than the short')
})

test('a credit unit leaning DOWN sells the call side', () => {
  const u = creditUnit(chainOf(24_000), 'down', 2, DIALS, DATE, MINUTE)
  assert.ok(u !== null)
  assert.deepEqual(u[0], { op: 'open', strike: 24_550, optType: 'CE', side: 'Buy', lots: 2 })
  assert.deepEqual(u[1], { op: 'open', strike: 24_250, optType: 'CE', side: 'Sell', lots: 2 })
  // Both legs carry the SAME lots — a wing that lags the short is a wing that
  // is not there for part of the position.
  assert.equal(opened(u[0]).lots, opened(u[1]).lots)
})

test('a credit unit ALWAYS buys its wing — a naked sale is not an option any more', () => {
  /**
   * D3: for a quiet open the hedge IS the strangle's two wings, and nothing
   * removes a hedge before the close. `dl_wings_on` was the dial that let an
   * operator choose a naked sale; it is gone, so the only way a short goes on
   * unbounded is a wing that is not on the ladder — and then the unit does not
   * form at all, which is the next test.
   */
  const u = creditUnit(chainOf(24_000), 'up', 2, DIALS, DATE, MINUTE)
  assert.ok(u !== null)
  assert.equal(u.length, 2)
  assert.equal(u[0]?.side, 'Buy', 'the wing is bought FIRST — never short a leg not yet covered')
  assert.equal(u[1]?.side, 'Sell')
  assert.equal(u[0]?.optType, 'PE')
  assert.equal(u[1]?.optType, 'PE')
  assert.ok((u[0] as { strike: number }).strike < (u[1] as { strike: number }).strike,
    'the wing sits further OTM than the short it protects')
})

test('a credit unit refuses a non-positive size rather than sending lots: 0', () => {
  assert.equal(creditUnit(chainOf(24_000), 'up', 0, DIALS, DATE, MINUTE), null)
  assert.equal(creditUnit(chainOf(24_000), 'up', -1, DIALS, DATE, MINUTE), null)
  // Half a lot is not a thing an exchange will take; it is a caller bug, and
  // silently flooring it would hide the bug behind a smaller position.
  assert.equal(creditUnit(chainOf(24_000), 'up', 1.5, DIALS, DATE, MINUTE), null)
})

test('a credit unit refuses when its wing is not on the ladder', () => {
  // Truncated at 23,600, the 0.10-delta put does not exist. With wings ON the
  // unit does not form — the alternative is selling the short and discovering
  // the wing is unbuyable afterwards.
  const short = LADDER.filter((k) => k >= 23_600)
  assert.equal(creditUnit(chainOf(SPOT, new Map(), short), 'up', 1, DIALS, DATE, MINUTE), null)
})

