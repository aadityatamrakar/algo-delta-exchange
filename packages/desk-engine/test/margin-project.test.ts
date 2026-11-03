/**
 * SPAN-LITE, CHECKED AGAINST THE PYTHON IT WAS TRANSLITERATED FROM.
 *
 * Every expected number below was produced by running
 * `sensibull_tools.sim.margin.portfolio_margin` in the Python desk's own venv
 * over the same book, at the same spot and date, and reading the answer off.
 * That is deliberately not hand-arithmetic: the function is 21 Black-76
 * repricings summed per scenario and then minimised, and a hand-derived
 * expectation would be checking my arithmetic rather than the port's. What
 * matters here is that the two implementations agree to the paise, which is
 * what makes a margin figure from this file comparable to every committed
 * Python board's margin column.
 *
 * The reference book is spot 300 on 2026-08-21 with a 2026-08-28 expiry (7
 * calendar days), lot size 25:
 *
 *   Sell 4 × 310 CE @ iv 0.30   span 5,138.98  exposure 1,500  total 6,638.98
 *   … + Buy 2 × 330 CE @ 0.30   span 3,492.73  exposure 1,500  total 4,992.73
 *   Sell 4 × 310 CE, iv absent  span 5,076.90  exposure 1,500  total 6,576.90
 *   Buy 2 × 330 CE alone        every field zero
 *   Sell 10 × 290 PE @ 0.30     span 12,876.04 exposure 3,750  total 16,626.04
 *   Sell 4 × 310 CE + 4 × 290 PE span 4,995.99 exposure 3,000  total 7,995.99
 *
 * Four properties are visible in that table and each has its own test, because
 * each is a thing the port could have got wrong while still returning a
 * plausible number: the hedge benefit falls out of the grid (the long wing takes
 * 1,646.25 off the span with no spread-matching logic anywhere), the exposure
 * add-on is 5% of SHORT notional and a long adds none of it, an absent IV takes
 * the 0.35 default rather than zeroing the leg, and a book with no short
 * exposure needs no margin at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  baseAfterExits,
  bookSpanLegs,
  calendarYearFrac,
  projectMarginCap,
  spanLiteMargin,
  type ChainSnap,
  type Dials,
  type EngineAction,
  type EngineInputs,
  type LegView,
  type OptType,
  type Quote,
  type Side,
  type SpanLeg,
} from '@algomaker/desk-engine'

const DATE = '2026-08-21'
const EXPIRY = '2026-08-28'
const NOW = 1_755_000_000_000

const span = (
  side: Side,
  lots: number,
  strike: number,
  optType: OptType,
  iv: number | null,
): SpanLeg => ({ strike, optType, side, lots, lotSize: 25, iv, expiry: EXPIRY })

// ── the reference table ─────────────────────────────────────────────────────

test('SPAN-lite reproduces portfolio_margin on a naked short, to the paise', () => {
  const r = spanLiteMargin([span('Sell', 4, 310, 'CE', 0.3)], 300, DATE)
  assert.deepEqual(r, {
    span: 5138.98,
    exposure: 1500,
    total: 6638.98,
    // The worst of the 21 is the full +21% shock at 1.25× vol, which is where a
    // short call hurts. Reading it back proves the grid is the right grid and
    // not merely a grid that happens to sum to the same number.
    worstScenario: { priceMovePct: 21, volMult: 1.25 },
    shortNotional: 30000,
    shortLots: 4,
  })
})

test('a long wing takes 1,646.25 off the span, and the grid is the only reason', () => {
  // `margin.py:13-17`: the hedge benefit falls out of the scenario grid because
  // the legs are summed PER SCENARIO before the minimum is taken. There is no
  // spread-matching code in the port and there must not be — this is what says
  // the port did not quietly add some.
  const naked = spanLiteMargin([span('Sell', 4, 310, 'CE', 0.3)], 300, DATE)
  const hedged = spanLiteMargin(
    [span('Sell', 4, 310, 'CE', 0.3), span('Buy', 2, 330, 'CE', 0.3)],
    300,
    DATE,
  )
  assert.equal(hedged.span, 3492.73)
  // Rounded, because the two rounded figures are the claim — subtracting them
  // in binary floating point lands on 1646.2499999999995.
  assert.equal(Math.round((naked.span - hedged.span) * 100) / 100, 1646.25)
  // The worst scenario MOVES with the hedge — 0.75× vol instead of 1.25× —
  // because the long's vega gain offsets the short's loss on the up-vol side.
  assert.deepEqual(hedged.worstScenario, { priceMovePct: 21, volMult: 0.75 })
  // …and the exposure add-on does NOT move: it is 5% of SHORT notional, and a
  // long option contributes none of it.
  assert.equal(hedged.exposure, naked.exposure)
  assert.equal(hedged.exposure, 1500)
})

test('an absent IV takes the 0.35 default, it does not zero the leg', () => {
  // `_leg_iv` (`margin.py:48-55`). A leg whose IV never solved must still be
  // margined — pricing it at zero vol would say a naked short is nearly free.
  const r = spanLiteMargin([span('Sell', 4, 310, 'CE', null)], 300, DATE)
  assert.equal(r.total, 6576.9)
  assert.equal(spanLiteMargin([span('Sell', 4, 310, 'CE', 0)], 300, DATE).total, 6576.9)
  // A NEGATIVE or non-finite vol is the same case, not a pricing input.
  assert.equal(spanLiteMargin([span('Sell', 4, 310, 'CE', -1)], 300, DATE).total, 6576.9)
})

test('a fully-paid long book needs no margin at all', () => {
  // `margin.py:132-135`. Real exchanges margin unbounded risk, never a paid-for
  // long, and a port that returned the 5% minimum here would cap out a book
  // that is carrying nothing.
  const r = spanLiteMargin([span('Buy', 2, 330, 'CE', 0.3)], 300, DATE)
  assert.deepEqual(r, {
    span: 0,
    exposure: 0,
    total: 0,
    worstScenario: { priceMovePct: 0, volMult: 1 },
    shortNotional: 0,
    shortLots: 0,
  })
})

test('the put wing is scanned DOWN, and a strangle is not the sum of its legs', () => {
  const pe = spanLiteMargin([span('Sell', 10, 290, 'PE', 0.3)], 300, DATE)
  assert.equal(pe.total, 16626.04)
  assert.deepEqual(pe.worstScenario, { priceMovePct: -21, volMult: 1.25 })

  const ce = spanLiteMargin([span('Sell', 4, 310, 'CE', 0.3)], 300, DATE)
  const both = spanLiteMargin(
    [span('Sell', 4, 310, 'CE', 0.3), span('Sell', 4, 290, 'PE', 0.3)],
    300,
    DATE,
  )
  assert.equal(both.total, 7995.99)
  // One shock cannot hurt both wings, so the strangle's span is LESS than the
  // two nakeds added — the same grid property as the long wing above, from the
  // other side. Its exposure IS additive, because notional is.
  const pe4 = spanLiteMargin([span('Sell', 4, 290, 'PE', 0.3)], 300, DATE)
  assert.ok(both.span < ce.span + pe4.span, `${both.span} should be under ${ce.span + pe4.span}`)
  assert.equal(both.exposure, ce.exposure + pe4.exposure)
  assert.equal(both.shortLots, 8)
})

test('a short-notional floor, not a scenario loss, is what margins a far-OTM short', () => {
  // `span = max(raw_span, min_short_pct * short_notional)` (`margin.py:140`).
  // A 400 CE seven days out at 30 vol barely moves in ANY of the 21 scenarios,
  // and without the floor a deep-OTM short would read as free.
  const far = spanLiteMargin([span('Sell', 4, 400, 'CE', 0.3)], 300, DATE)
  assert.equal(far.span, 0.05 * far.shortNotional)
  assert.equal(far.span, 1500)
  assert.equal(far.total, 3000) // the floor plus the 5% exposure add-on
})

test('a zero spot, an empty book or a zero-share leg is the zero-shaped result', () => {
  const zero = {
    span: 0,
    exposure: 0,
    total: 0,
    worstScenario: { priceMovePct: 0, volMult: 1 },
    shortNotional: 0,
    shortLots: 0,
  }
  assert.deepEqual(spanLiteMargin([], 300, DATE), zero)
  assert.deepEqual(spanLiteMargin([span('Sell', 4, 310, 'CE', 0.3)], 0, DATE), zero)
  assert.deepEqual(spanLiteMargin([span('Sell', 4, 310, 'CE', 0.3)], Number.NaN, DATE), zero)
  // A leg holding no shares is skipped, so a book of them has no short exposure
  // and takes the no-margin branch rather than a NaN.
  assert.deepEqual(spanLiteMargin([span('Sell', 0, 310, 'CE', 0.3)], 300, DATE), zero)
})

test('the tenor is the CALENDAR one — `year_frac`, not `year_frac_at`', () => {
  // `pricing.py:46-49`. Plain days over 365, floored at zero, no intraday
  // refinement — see `margin-project.ts` §2 for why the two must differ.
  assert.equal(calendarYearFrac('2026-08-21', '2026-08-28'), 7 / 365)
  assert.equal(calendarYearFrac('2026-08-21', '2026-08-21'), 0)
  assert.equal(calendarYearFrac('2026-08-28', '2026-08-21'), 0) // past expiry
  assert.equal(calendarYearFrac('nonsense', '2026-08-28'), 0)
  assert.equal(calendarYearFrac('2026-02-31', '2026-08-28'), 0) // Date.UTC would roll it over

  // An expiry-day leg is floored at ~1 hour rather than priced at zero tenor,
  // which would collapse the whole grid onto intrinsic (`margin.py:36`). Python
  // answers 6,799.96 on the expiry date and the SAME figure a day past it — the
  // floor is what makes the second one finite at all.
  assert.equal(spanLiteMargin([span('Sell', 4, 310, 'CE', 0.3)], 300, EXPIRY).total, 6799.96)
  assert.equal(spanLiteMargin([span('Sell', 4, 310, 'CE', 0.3)], 300, '2026-08-29').total, 6799.96)
  // An unparseable expiry takes the same floor rather than dropping the leg out
  // of the book it is the risk in.
  assert.equal(
    spanLiteMargin([{ ...span('Sell', 4, 310, 'CE', 0.3), expiry: '' }], 300, DATE).total,
    6799.96,
  )
})

// ── the base a projection is taken over ─────────────────────────────────────

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })

let seq = 0
function leg(over: Partial<LegView> = {}): LegView {
  seq += 1
  return {
    instrument: `LEG${seq}`,
    strike: 310,
    optType: 'CE',
    side: 'Sell',
    lots: 4,
    lotSize: 25,
    entry: 10,
    openedByEngine: true,
    // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
    leanId: '',
    iv: 0.3,
    delta: 0.22,
    gamma: 0.01,
    // Inert on every recenter path — nothing here reads either greek. Carried
    // because `LegView` requires them (`types.ts`): theta per calendar day,
    // vega per vol point, both per-share.
    theta: 0,
    vega: 0,
    hasGreeks: true,
    mtm: 0,
    exit: q(9, 11),
    ...over,
  }
}

test('the projection base drops what the package closes and RESIZES what it part-closes', () => {
  // `engine.py:1045-1055`: a partial close frees only its own lots' worth of
  // margin, so the leg stays in the base at its surviving size. Dropping it
  // whole would credit relief the book never gets and oversize the same
  // package's sale.
  const a = leg({ lots: 4 })
  const b = leg({ lots: 6, strike: 290, optType: 'PE' })
  const c = leg({ lots: 2, strike: 330, side: 'Buy' })
  const actions: EngineAction[] = [
    { op: 'close', instrument: a.instrument },
    { op: 'resize', instrument: b.instrument, targetLots: 2 },
  ]
  assert.deepEqual(baseAfterExits([a, b, c], actions, EXPIRY), [
    { strike: 290, optType: 'PE', side: 'Sell', lots: 2, lotSize: 25, iv: 0.3, expiry: EXPIRY },
    { strike: 330, optType: 'CE', side: 'Buy', lots: 2, lotSize: 25, iv: 0.3, expiry: EXPIRY },
  ])
  // A resize to nothing is a close.
  assert.deepEqual(
    baseAfterExits([a], [{ op: 'resize', instrument: a.instrument, targetLots: 0 }], EXPIRY),
    [],
  )
})

test('an unmarked leg carries a null IV into the grid, never a stale one', () => {
  // `hasGreeks: false` means the IV solve failed (`types.ts` §2). Passing the
  // stale `iv` field through would price the leg at a vol nothing measured.
  const l = leg({ hasGreeks: false, iv: 0.9 })
  assert.deepEqual(bookSpanLegs([l], EXPIRY), [
    { strike: 310, optType: 'CE', side: 'Sell', lots: 4, lotSize: 25, iv: null, expiry: EXPIRY },
  ])
})

// ── the cap gate ────────────────────────────────────────────────────────────

function chainOf(spot: number): ChainSnap {
  return {
    symbol: 'TEST',
    expiry: EXPIRY,
    step: 10,
    lotSize: 25,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: [],
    asOf: NOW,
  }
}

function inputsOf(legs: LegView[]): EngineInputs {
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: NOW,
    dateIst: DATE,
    minuteOfDay: 600,
    dte: 7,
    chain: chainOf(300),
    legs,
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'broker', asOf: NOW, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
  }
}

const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })

/** The brief's hand-computed case, on the reference book.
 *
 * Base = the naked 4 × 310 CE = 6,638.98. A fresh 10-lot 320 CE sale projects
 * to 21,001.16, so the package's own load is 14,362.18. Against a cap of
 * 13,000 the scale factor is (13,000 − 6,638.98) / 14,362.18 = 0.442896, and
 * `int(10 × 0.442896)` is 4 — Python truncates, it does not round, because
 * rounding up is what puts a package back over the cap it was just scaled to
 * fit. The 4-lot reprojection is 12,383.85, which fits, so the downsize stands.
 *
 * (The brief phrased this as "what 0.95 × cap admits". The 0.95 hysteresis is
 * the margin GUARD's trim target — `_MARGIN_HYSTERESIS`, `engine.py:87` — and
 * the pre-trade projection is measured against the cap itself,
 * `engine.py:1073`. 4 lots at 12,383.85 sits just over 0.95 × 13,000 = 12,350,
 * so the two rules genuinely disagree here and the port follows Python.) */
const projectionBook = () => [leg({ lots: 4, strike: 310, optType: 'CE', side: 'Sell' })]
const tenLotSale: EngineAction = { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 10 }

test('a 10-lot open is DOWNSIZED to the lots the cap admits, truncated', () => {
  const out = projectMarginCap(inputsOf(projectionBook()), dialsOf({ margin_cap: 13000 }), [
    tenLotSale,
  ])
  assert.equal(out.verdict, 'downsized')
  assert.equal(out.base, 6638.98)
  assert.equal(out.projected, 21001.16)
  assert.deepEqual(out.actions, [{ ...tenLotSale, lots: 4 }])
  // And the surviving package really does fit, which is the claim the reprojection
  // makes rather than assumes.
  assert.equal(
    spanLiteMargin(
      [...bookSpanLegs(projectionBook(), EXPIRY), span('Sell', 4, 320, 'CE', null)],
      300,
      DATE,
    ).total,
    12383.85,
  )
})

test('a package that fits whole is returned untouched, object for object', () => {
  const actions = [tenLotSale]
  const out = projectMarginCap(inputsOf(projectionBook()), dialsOf({ margin_cap: 25000 }), actions)
  assert.equal(out.verdict, 'fits')
  assert.equal(out.actions, actions) // the same array, not a copy
})

test('margin_cap 0 is UNCAPPED and disables the gate, not the selling', () => {
  const out = projectMarginCap(inputsOf(projectionBook()), dialsOf({ margin_cap: 0 }), [tenLotSale])
  assert.equal(out.verdict, 'fits')
  assert.deepEqual(out.actions, [tenLotSale])
})

test('with no headroom at all the SELLS go and the closes stay — a roll degrades', () => {
  // `_strip_sells` (`engine.py:1088-1095`): a roll at the cap degrades to
  // closing the tested short, never to holding it naked at the cap.
  const book = projectionBook()
  const first = book[0]
  assert.ok(first !== undefined)
  const close: EngineAction = { op: 'close', instrument: first.instrument }
  const out = projectMarginCap(inputsOf(book), dialsOf({ margin_cap: 700 }), [close, tenLotSale])
  assert.equal(out.verdict, 'sells-dropped')
  assert.deepEqual(out.actions, [close])
})

test('a sells-only package with no headroom becomes a HOLD, never a bare nothing', () => {
  const out = projectMarginCap(inputsOf(projectionBook()), dialsOf({ margin_cap: 6700 }), [
    tenLotSale,
  ])
  assert.equal(out.verdict, 'hold')
  assert.deepEqual(out.actions, [])
})

test('a Buy open is never projected away — it only ever helps margin', () => {
  const buy: EngineAction = { op: 'open', strike: 330, optType: 'CE', side: 'Buy', lots: 2 }
  const out = projectMarginCap(inputsOf(projectionBook()), dialsOf({ margin_cap: 700 }), [buy])
  assert.equal(out.verdict, 'fits')
  assert.deepEqual(out.actions, [buy])
  // …and it survives when the Sell beside it does not.
  const mixed = projectMarginCap(inputsOf(projectionBook()), dialsOf({ margin_cap: 700 }), [
    buy,
    tenLotSale,
  ])
  assert.equal(mixed.verdict, 'sells-dropped')
  assert.deepEqual(mixed.actions, [buy])
})

test('the projection is NET OF THE PACKAGE’S OWN CLOSES', () => {
  // `engine.py:1015-1021`. The same 10-lot sale that does not fit beside the
  // existing short fits once that short is being closed in the same package —
  // else every roll at the cap reads as a pure margin add and defence starves.
  const book = projectionBook()
  const first = book[0]
  assert.ok(first !== undefined)
  const close: EngineAction = { op: 'close', instrument: first.instrument }
  const cap = 15000

  const alone = projectMarginCap(inputsOf(book), dialsOf({ margin_cap: cap }), [tenLotSale])
  assert.equal(alone.verdict, 'downsized')

  const rolled = projectMarginCap(inputsOf(book), dialsOf({ margin_cap: cap }), [close, tenLotSale])
  assert.equal(rolled.verdict, 'fits')
  assert.deepEqual(rolled.actions, [close, tenLotSale])
})
