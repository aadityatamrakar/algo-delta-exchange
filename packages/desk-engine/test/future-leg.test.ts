/**
 * THE FUTURE LEG KIND — MEASURED BY THE CORRIDOR, NEVER ACTED ON (traders P2).
 *
 * A trader's book can carry futures and shares beside its options. The engine
 * counts them where it MEASURES the book — the corridor's netΔ, at sign ×
 * shares, and nothing in netΓ (Python's future leg, `book.py:223`) — and hides
 * them from every tier that can NAME a leg: the settle, the guards, the scrap
 * tier, phase S, phase R's package and the gates.
 *
 * The desk's books carry no future leg, and `kind` is optional with absent
 * meaning `'option'`, so one block below pins the claim the desk depends on: a
 * book whose legs say `kind: 'option'` decides exactly as the same book without
 * the field.
 *
 * Fixtures are `corridor.test.ts`'s `leg()` and `chainOf()`: spot 300, lot 25.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  PRESETS,
  RISK_FREE,
  TRADER_PRESET,
  corridor,
  decide,
  resolveDials,
  sellLotSize,
  type ChainSnap,
  type Dials,
  type EngineDecision,
  type EngineInputs,
  type LegView,
  type MarkContext,
  type OptType,
  type Quote,
  type Side,
  type Trigger,
} from '@algomaker/desk-engine'
import { b76Price } from '@algomaker/greeks'

const DATE = '2026-08-21' // a Friday
const EXPIRY = '2026-08-28'
const MINUTE = 600 // 10:00 IST — seven whole days out
const T7 = 7 / 365
const VOL = 0.3
const NOW = 1_755_000_000_000

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`. */
function bookAt(spot: number, strike: number, type: OptType): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.98, px * 1.02)
}

function chainOf(spot: number, strikes: number[], step: number, lotSize: number): ChainSnap {
  return {
    symbol: 'VEDL',
    expiry: EXPIRY,
    step,
    lotSize,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: strikes.map((k) => ({ strike: k, ce: bookAt(spot, k, 'CE'), pe: bookAt(spot, k, 'PE') })),
    asOf: NOW,
  }
}

const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * 10)

let legSeq = 0
function leg(over: Partial<LegView> = {}): LegView {
  legSeq += 1
  return {
    instrument: `LEG${legSeq}`,
    strike: 300,
    optType: 'CE',
    side: 'Sell',
    lots: 1,
    lotSize: 25,
    entry: 10,
    openedByEngine: true,
    leanId: '',
    iv: VOL,
    delta: 0.5,
    gamma: 0.01,
    theta: 0,
    vega: 0,
    hasGreeks: true,
    mtm: 0,
    exit: q(9, 11),
    ...over,
  }
}

/** A future (or share) leg as the traders app builds one: lot 1, so `lots` is
 * shares, and by convention strike 0, CE, delta 1 and no other greek — none of
 * which the engine reads. */
function future(side: Side, shares: number, over: Partial<LegView> = {}): LegView {
  return leg({
    instrument: `FUT${legSeq + 1}`,
    kind: 'future',
    side,
    lots: shares,
    lotSize: 1,
    strike: 0,
    optType: 'CE',
    entry: 300,
    iv: null,
    delta: 1,
    gamma: 0,
    exit: q(299.9, 300.1),
    ...over,
  })
}

function inputsOf(legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: NOW,
    dateIst: DATE,
    minuteOfDay: MINUTE,
    dte: 7,
    chain: chainOf(300, LADDER, 10, 25),
    legs,
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'broker', asOf: NOW, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
    ...over,
  }
}

const mark = (over: Partial<MarkContext> = {}): MarkContext => ({
  isNewMark: true,
  markIndexToday: 5,
  ...over,
})

const TRADER: Dials = resolveDials(TRADER_PRESET.dials).dials
const reliefR = PRESETS.find((p) => p.key === 'recenter-relief-r')
assert.ok(reliefR)
const RELIEF_R: Dials = resolveDials(reliefR.dials).dials

const closed = (out: EngineDecision): string[] =>
  out.actions.flatMap((a) => (a.op === 'close' ? [a.instrument] : [])).sort()
const soldLots = (out: EngineDecision): number =>
  out.actions.reduce((n, a) => (a.op === 'open' && a.side === 'Sell' ? n + a.lots : n), 0)

// ── the corridor counts it ──────────────────────────────────────────────────

test('a future leg counts sign × shares in netDelta and nothing in netGamma', () => {
  // Short 2 lots of CE: −0.4 × 50 = −20 delta, −0.01 × 50 = −0.5 gamma. The
  // long future adds +100 shares of delta and no gamma.
  const short = leg({ side: 'Sell', optType: 'CE', lots: 2, delta: 0.4, gamma: 0.01 })
  const cor = corridor(inputsOf([short, future('Buy', 100)]), TRADER)
  assert.equal(cor.netDelta, 80)
  assert.equal(cor.netGamma, -0.5)

  // Its side and its shares, never its greeks: a future carrying a put's delta
  // and some gamma, in a book where every leg is in the gamma population, still
  // reads +100 and 0.
  const odd = future('Buy', 100, { optType: 'PE', delta: 0.37, gamma: 0.05 })
  const whole = corridor(inputsOf([short, odd]), { ...TRADER, gamma_shorts_only: false })
  assert.equal(whole.netDelta, 80)
  assert.equal(whole.netGamma, -0.5)
})

test('shorts-only keeps a short future out', () => {
  // Python's `K.shorts` is "option AND sell": a short future is not a short.
  const short = leg({ side: 'Sell', optType: 'CE', lots: 2, delta: 0.4, gamma: 0.01 })
  const cor = corridor(inputsOf([short, future('Sell', 100)]), RELIEF_R)
  assert.equal(cor.netDelta, -20)
  assert.equal(cor.netGamma, -0.5)
})

test('under trader a long future hedges the short calls', () => {
  // −0.5 × 4 × 25 = −50, and 50 long shares cancel it.
  const short = leg({ side: 'Sell', optType: 'CE', lots: 4, delta: 0.5, gamma: 0.01 })
  const cor = corridor(inputsOf([short, future('Buy', 50)]), TRADER)
  assert.equal(cor.netDelta, 0)
})

test('sellLotSize skips a future even when it is the first short', () => {
  // The chain's lot is 50, so 25 can only be the short CE's.
  const legs = [future('Sell', 100), leg({ side: 'Sell', optType: 'CE', lotSize: 25 })]
  assert.equal(sellLotSize(legs, chainOf(300, [], 10, 50)), 25)
})

// ── the desk's books: an explicit 'option' changes nothing ──────────────────

test("kind 'option' is the same as absent", () => {
  const books: ReadonlyArray<{
    readonly name: string
    readonly legs: LegView[]
    readonly over?: Partial<EngineInputs>
    readonly trigger: Trigger
  }> = [
    { name: 'flat', legs: [], trigger: 'none' },
    {
      name: 'short strangle in band',
      legs: [
        leg({ strike: 330, optType: 'CE', lots: 4, delta: 0.2, gamma: 0.02 }),
        leg({ strike: 270, optType: 'PE', lots: 4, delta: 0.2, gamma: 0.02 }),
      ],
      trigger: 'none',
    },
    {
      name: 'out of band long',
      legs: [leg({ optType: 'PE', lots: 4, delta: 0.9, gamma: 0.1 })],
      trigger: 'shed',
    },
    {
      name: 'out of band short',
      legs: [leg({ optType: 'CE', lots: 4, delta: 0.9, gamma: 0.1 })],
      trigger: 'shed',
    },
    {
      name: 'a short at Rs0.05',
      legs: [leg({ optType: 'PE', lots: 4, delta: 0.9, gamma: 0.1, exit: q(0.05, 0.07) })],
      trigger: 'scrap',
    },
    {
      name: 'expiry day at 15:30',
      legs: [leg({ optType: 'PE', lots: 4, delta: 0.9, gamma: 0.1 })],
      over: { dte: 0, minuteOfDay: 930 },
      trigger: 'expiry',
    },
  ]
  for (const [dialsName, dials] of [['desk', DEFAULT_DIALS], ['trader', TRADER]] as const) {
    for (const b of books) {
      const inputs = inputsOf(b.legs, b.over)
      const tagged = { ...inputs, legs: b.legs.map((l): LegView => ({ ...l, kind: 'option' })) }
      const plain = decide(inputs, dials, EMPTY_RULE_STATE, mark())
      // Each book reaches the branch it is named for, so the comparison below
      // is never two holds that agree by accident.
      assert.equal(plain.trigger, b.trigger, `${dialsName}: ${b.name}`)
      assert.deepEqual(decide(tagged, dials, EMPTY_RULE_STATE, mark()), plain, `${dialsName}: ${b.name}`)
    }
  }
})

// ── decide() never acts on it ───────────────────────────────────────────────

test('decide never names a future leg', () => {
  const ce = leg({ strike: 330, optType: 'CE', lots: 2, mtm: 1_000 })
  const pe = leg({ strike: 270, optType: 'PE', lots: 2, mtm: 1_000 })
  const fut = future('Buy', 100)

  // (a) The expiry settle closes the options, which leave the master tonight;
  // the future is not this chain's to close.
  const settle = decide(inputsOf([ce, fut, pe], { dte: 0, minuteOfDay: 930 }), TRADER, EMPTY_RULE_STATE, mark())
  assert.equal(settle.trigger, 'expiry')
  assert.deepEqual(closed(settle), [ce.instrument, pe.instrument].sort())
  assert.match(settle.reason, /closing all 2 leg\(s\)/)

  // (b) An out-of-band shed. The short future would read as a deep-ITM short
  // call at strike 0 to phase S; the shed is sized off the whole book, it
  // included, and names only chain strikes.
  const short = leg({ optType: 'CE', lots: 4, delta: 0.9, gamma: 0.1 })
  const shortFut = future('Sell', 100)
  const shed = decide(inputsOf([short, shortFut]), TRADER, EMPTY_RULE_STATE, mark())
  assert.equal(shed.action, 'adjust')
  assert.equal(shed.trigger, 'shed')
  assert.deepEqual(closed(shed), [])
  for (const a of shed.actions) {
    assert.ok(a.op === 'open' && LADDER.includes(a.strike), `a chain strike: ${JSON.stringify(a)}`)
  }
  const alone = decide(inputsOf([short]), TRADER, EMPTY_RULE_STATE, mark())
  assert.ok(soldLots(shed) > soldLots(alone), 'the future short delta is in the band the shed sizes off')

  // (c) The target lock's flatten, on its third confirming mark.
  const lock = decide(
    inputsOf([ce, fut, pe]),
    { ...TRADER, target_pnl: 1 },
    { ...EMPTY_RULE_STATE, targetStreak: 2 },
    mark({ isNewMark: true }),
  )
  assert.equal(lock.action, 'flatten')
  assert.equal(lock.trigger, 'lock')
  assert.deepEqual(closed(lock), [ce.instrument, pe.instrument].sort())
})

test('a futures-only book holds', () => {
  // Short futures and long shares, no option: nothing the engine may adjust.
  // `min_band_lots` 1 gives the book a one-lot band its −50 shares are outside,
  // and it still holds as a flat book rather than selling options against it.
  for (const dials of [TRADER, { ...TRADER, min_band_lots: 1 }]) {
    const out = decide(
      inputsOf([future('Sell', 100), future('Buy', 50)]),
      dials,
      EMPTY_RULE_STATE,
      mark(),
    )
    assert.equal(out.action, 'hold')
    assert.deepEqual(out.actions, [])
    assert.match(out.reason, /flat book/)
  }
})
