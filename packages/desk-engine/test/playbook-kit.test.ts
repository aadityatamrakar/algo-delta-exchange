/**
 * THE PLAYBOOK KIT — the strike, structure and debounce helpers every strategy
 * builds its answers from (six-playbooks spec §4.6, §4.7).
 *
 * The kit is where a strategy's plan acquires its strikes, so each helper is
 * pinned for the one way it could hand the frame a package that is wrong
 * while looking fine:
 *
 *   - a wing judged on the wrong clock or the wrong spread is a leg that will
 *     not fill — and a protective leg that does not fill is the half-built
 *     package the whole staging rule exists for;
 *   - a strike the book holds on the OTHER side, chosen again, is netted away
 *     downstream (a partial close nobody decided);
 *   - a short whose `cover` names the wrong strike is checked against a leg
 *     that is not its protection;
 *   - a debounce that does not reset, or that fires on its first pass, turns
 *     one bad print into a stop.
 *
 * THE BOARD is the scenario harness's Black-76 chain at 25,000 (NIFTY, one
 * trading day to the Monday weekly), so every delta read here is the model's.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { strikeGreeks } from '../src/marking.ts'
import { atmStraddleMid } from '../src/delta-lean/regime.ts'
import type { ChainSnap, OptType, Quote } from '../src/types.ts'
import {
  atmOf,
  d2Close,
  debitByBands,
  debitSpreadMax,
  debitByStraddle,
  flyPlan,
  held,
  heldOpposite,
  heldRupee,
  heldSame,
  liquidWing,
  listedBeyond,
  lotsHeld,
  openOf,
  shortsValue,
  stepsFrom,
  trendSide,
  windowRange,
} from '../src/delta-lean/playbook/kit.ts'
import { at, chainAt, ctxOf, DATE, dialsOf, inputsAt, legOn, OPEN, Tape } from './playbook-fixture.ts'

const NOW = at(600) // 10:00
const DIALS = dialsOf()

function market(): { tape: Tape; chain: ChainSnap } {
  const tape = new Tape()
  tape.advanceTo(NOW)
  return { tape, chain: chainAt(NOW, OPEN) }
}

/** The chain with one wing's quote replaced. */
function withQuote(chain: ChainSnap, strike: number, optType: OptType, q: Quote | null): ChainSnap {
  return {
    ...chain,
    strikes: chain.strikes.map((r) =>
      r.strike !== strike ? r : optType === 'CE' ? { ...r, ce: q } : { ...r, pe: q }),
  }
}

const quoteOf = (chain: ChainSnap, strike: number, optType: OptType): Quote => {
  const row = chain.strikes.find((r) => r.strike === strike)
  const q = optType === 'CE' ? row?.ce : row?.pe
  assert.ok(q !== null && q !== undefined, `${strike}${optType} is quoted`)
  return q
}

const deltaOf = (chain: ChainSnap, strike: number, optType: OptType): number => {
  const g = strikeGreeks(chain, strike, optType, DATE, 600)
  assert.ok(g !== null)
  return Math.abs(g.delta)
}

// ── strikes ─────────────────────────────────────────────────────────────────

test('atmOf is the listed strike nearest the forward, a tie going to the LOWER strike', () => {
  const { chain } = market()
  assert.equal(atmOf(chain), 25_000)
  assert.equal(atmOf({ ...chain, spot: 25_025 }), 25_000, 'half way: the lower strike')
  assert.equal(atmOf({ ...chain, spot: 25_026 }), 25_050)
  assert.equal(atmOf({ ...chain, strikes: [] }), null)
  // The ladder's order is not the tie-break: reversed, the tie still goes low.
  assert.equal(atmOf({ ...chain, spot: 25_025, strikes: [...chain.strikes].reverse() }), 25_000)
})

test('listedBeyond and stepsFrom find listed strikes, and answer null at the edge of the chain', () => {
  const { chain } = market() // 23,750 .. 26,250 by 50
  assert.equal(listedBeyond(chain, 25_000, 1, 100), 25_100)
  assert.equal(listedBeyond(chain, 25_000, 1, 101), 25_150, 'at least the distance, never less')
  assert.equal(listedBeyond(chain, 25_000, -1, 130), 24_850)
  assert.equal(listedBeyond(chain, 26_200, 1, 100), null, 'nothing listed that far up')
  assert.equal(listedBeyond(chain, 23_800, -1, 100), null, 'nor that far down')
  assert.equal(stepsFrom(chain, 25_000, 4), 25_200)
  assert.equal(stepsFrom(chain, 25_000, -5), 24_750)
  assert.equal(stepsFrom(chain, 25_000, 26), null, '26 steps up is off the board')
  assert.equal(stepsFrom(chain, 25_010, 1), null, 'a ladder reached from an unlisted strike is not listed')
})

// ── liquidity, per wing (§4.7) ──────────────────────────────────────────────

test('liquidWing: a two-sided quote inside the spread bar, fresh against chain.asOf — the protective clock looser than the short one', () => {
  const { chain } = market()
  const k = 25_000
  const q = quoteOf(chain, k, 'CE')
  assert.equal(liquidWing(chain, k, 'CE', DIALS, false), true)
  assert.equal(liquidWing(chain, k, 'CE', DIALS, true), true)

  assert.equal(liquidWing(withQuote(chain, k, 'CE', null), k, 'CE', DIALS, true), false, 'no quote')
  assert.equal(liquidWing(withQuote(chain, k, 'CE', { ...q, bid: null }), k, 'CE', DIALS, true), false, 'one-sided')
  assert.equal(liquidWing(withQuote(chain, k, 'CE', { ...q, bid: 0 }), k, 'CE', DIALS, true), false, 'a zero bid is not a bid')
  const mid = ((q.bid ?? 0) + (q.ask ?? 0)) / 2
  const wide = { ...q, bid: mid - 0.011 * mid, ask: mid + 0.011 * mid } // 2.2% wide, past 2%
  assert.equal(liquidWing(withQuote(chain, k, 'CE', wide), k, 'CE', DIALS, true), false, 'wider than the bar')
  // A rupee option may be a rupee wide: the absolute floor (dl_max_spread_abs).
  const cheap = { ...q, bid: 0.5, ask: 1.4 }
  assert.equal(liquidWing(withQuote(chain, k, 'CE', cheap), k, 'CE', DIALS, true), true, 'inside the ₹1 floor')
  // A PROTECTIVE leg's floor is pb_wing_spread_abs (₹2): a ₹30 SENSEX wing
  // ₹1.5 wide is bought, but not sold — a sale keeps the ₹1 / 2% bar.
  const farWing = { ...q, bid: 29.25, ask: 30.75 }
  assert.equal(liquidWing(withQuote(chain, k, 'CE', farWing), k, 'CE', DIALS, true), true, 'a wing ₹1.5 wide is inside the ₹2 protective floor')
  assert.equal(liquidWing(withQuote(chain, k, 'CE', farWing), k, 'CE', DIALS, false), false, 'a short ₹1.5 wide on ₹30 is past 2% and ₹1')
  const tooWide = { ...q, bid: 28.9, ask: 31.1 }
  assert.equal(liquidWing(withQuote(chain, k, 'CE', tooWide), k, 'CE', DIALS, true), false, 'a wing ₹2.2 wide is past the ₹2 floor')
  // The protective floor can only loosen the bar: under dl_max_spread_abs it changes nothing.
  const lowFloor = { ...DIALS, pb_wing_spread_abs: 0 }
  assert.equal(liquidWing(withQuote(chain, k, 'CE', cheap), k, 'CE', lowFloor, true), true, 'pb_wing_spread_abs 0 falls back to the ₹1 floor')
  assert.equal(liquidWing(withQuote(chain, k, 'CE', farWing), k, 'CE', lowFloor, true), false, 'and a ₹1.5 spread is past it again')

  // Freshness is a ROW lagging the board: measured against chain.asOf.
  const aged = (s: number): Quote => ({ ...q, asOf: chain.asOf - s * 1000 })
  assert.equal(liquidWing(withQuote(chain, k, 'CE', aged(20)), k, 'CE', DIALS, true), true, 'a wing 20 s old is still a wing (pb_wing_fresh_s 30)')
  assert.equal(liquidWing(withQuote(chain, k, 'CE', aged(20)), k, 'CE', DIALS, false), false, 'a short 20 s old is not (dl_quote_fresh_s 3)')
  assert.equal(liquidWing(withQuote(chain, k, 'CE', aged(31)), k, 'CE', DIALS, true), false)
  assert.equal(liquidWing(chain, 25_010, 'CE', DIALS, true), false, 'an unlisted strike')
})

// ── what the book holds ─────────────────────────────────────────────────────

test('heldSame, heldOpposite and lotsHeld read the book by strike, type and side; openOf marks a same-side add', () => {
  const { chain } = market()
  const legs = [legOn(chain, 24_950, 'CE', 'Buy', 2), legOn(chain, 25_150, 'CE', 'Sell', 1)]
  assert.equal(heldSame(legs, 24_950, 'CE', 'Buy'), true)
  assert.equal(heldSame(legs, 24_950, 'PE', 'Buy'), false, 'the other type')
  assert.equal(heldOpposite(legs, 24_950, 'CE', 'Sell'), true, 'selling a strike held long')
  assert.equal(heldOpposite(legs, 25_150, 'CE', 'Buy'), true, 'buying a strike held short')
  assert.equal(heldOpposite(legs, 25_150, 'CE', 'Sell'), false)
  assert.equal(lotsHeld(legs, 24_950, 'CE', 'Buy'), 2)
  assert.equal(lotsHeld(legs, 24_950, 'CE', 'Sell'), 0)

  assert.deepEqual(openOf(24_950, 'CE', 'Buy', legs), { op: 'open', strike: 24_950, optType: 'CE', side: 'Buy', lots: 1, add: true })
  assert.deepEqual(openOf(25_000, 'CE', 'Buy', legs), { op: 'open', strike: 25_000, optType: 'CE', side: 'Buy', lots: 1 })
  assert.equal('add' in openOf(25_150, 'CE', 'Buy', legs), false, 'an opposite-side open is never an add')
})

// ── structures ──────────────────────────────────────────────────────────────

test('debitByBands: the long in the long band, the short in the short band strictly further OTM, covered by the long', () => {
  const { tape, chain } = market()
  const ctx = ctxOf(inputsAt(tape, NOW, { chain }), DIALS)
  const up = debitByBands(ctx, 'up')
  assert.ok(up !== null)
  const long = up.protective[0]
  const short = up.shorts[0]
  assert.ok(long !== undefined && short !== undefined)
  assert.equal(up.protective.length, 1)
  assert.equal(up.shorts.length, 1)
  assert.deepEqual([long.optType, long.side, long.lots], ['CE', 'Buy', 1])
  assert.equal(short.optType, 'CE')
  assert.equal(short.cover, long.strike, 'the short is covered by THE long')
  assert.ok(short.strike > long.strike, 'further out of the money')
  const dl = deltaOf(chain, long.strike, 'CE')
  const ds = deltaOf(chain, short.strike, 'CE')
  assert.ok(dl >= 0.55 && dl <= 0.65, `long delta ${dl}`)
  assert.ok(ds >= 0.2 && ds <= 0.3, `short delta ${ds}`)

  const down = debitByBands(ctx, 'down')
  assert.ok(down !== null)
  assert.equal(down.protective[0]?.optType, 'PE')
  assert.ok((down.shorts[0]?.strike ?? Infinity) < (down.protective[0]?.strike ?? -Infinity), 'a put spread sells lower')
})

test('debitByBands never chooses a strike the book holds on the other side', () => {
  const { tape, chain } = market()
  // On the shipped bands this board holds ONE strike in each, so a held
  // opposite there leaves no spread at all.
  const narrow = debitByBands(ctxOf(inputsAt(tape, NOW, { chain }), DIALS), 'up')
  assert.ok(narrow !== null)
  const onlyLong = narrow.protective[0]?.strike ?? Number.NaN
  const blocked = ctxOf(inputsAt(tape, NOW, { chain, legs: [legOn(chain, onlyLong, 'CE', 'Sell', 1)] }), DIALS)
  assert.equal(debitByBands(blocked, 'up'), null, 'the band\'s only long is held short: no spread, never that strike')

  // Wider bands hold several candidates, so the exclusion has somewhere to go.
  const wide = dialsOf({ dl_long_delta_lo: 0.45, dl_long_delta_hi: 0.8, dl_short_delta_lo: 0.1, dl_short_delta_hi: 0.35 })
  const free = debitByBands(ctxOf(inputsAt(tape, NOW, { chain }), wide), 'up')
  assert.ok(free !== null)
  const longK = free.protective[0]?.strike ?? Number.NaN
  const shortK = free.shorts[0]?.strike ?? Number.NaN
  // The long strike held SHORT: buying it would net the short away.
  const heldShort = debitByBands(ctxOf(inputsAt(tape, NOW, { chain, legs: [legOn(chain, longK, 'CE', 'Sell', 1)] }), wide), 'up')
  assert.ok(heldShort !== null, 'another long in the band')
  assert.notEqual(heldShort.protective[0]?.strike, longK)
  // The short strike held LONG: selling it would close a held long.
  const heldLong = debitByBands(ctxOf(inputsAt(tape, NOW, { chain, legs: [legOn(chain, shortK, 'CE', 'Buy', 1)] }), wide), 'up')
  assert.ok(heldLong !== null, 'another short in the band')
  assert.notEqual(heldLong.shorts[0]?.strike, shortK)
  assert.ok((heldLong.shorts[0]?.strike ?? 0) > (heldLong.protective[0]?.strike ?? Infinity), 'still further out')
  // A short wing with no two-sided quote is passed over, never half-used.
  const oneSided = withQuote(chain, shortK, 'CE', { ...quoteOf(chain, shortK, 'CE'), bid: null, ask: null })
  const r = debitByBands(ctxOf(inputsAt(tape, NOW, { chain: oneSided }), wide), 'up')
  assert.ok(r !== null)
  assert.notEqual(r.shorts[0]?.strike, shortK)
})

test('debitByStraddle: buy ATM, sell the first strike at least max(1 step, pb_short_str_k x STR) beyond it', () => {
  const { tape, chain } = market()
  const str = atmStraddleMid(chain)
  assert.ok(str !== null && str > 0)
  const ctx = ctxOf(inputsAt(tape, NOW, { chain }), dialsOf({ pb_short_str_k: 0.6 }))
  const up = debitByStraddle(ctx, 'up')
  assert.ok(up !== null)
  assert.equal(up.protective[0]?.strike, 25_000)
  assert.equal(up.protective[0]?.optType, 'CE')
  const want = Math.ceil((0.6 * str) / 50) * 50 // first listed strike at least that far
  assert.equal(up.shorts[0]?.strike, 25_000 + want)
  assert.equal(up.shorts[0]?.cover, 25_000)
  const down = debitByStraddle(ctx, 'down')
  assert.equal(down?.protective[0]?.optType, 'PE')
  assert.equal(down?.shorts[0]?.strike, 25_000 - want)
  // A straddle so cheap that k x STR is under a step: one step, never ATM.
  const tiny = debitByStraddle(ctxOf(inputsAt(tape, NOW, { chain }), dialsOf({ pb_short_str_k: 0.01 })), 'up')
  assert.equal(tiny?.shorts[0]?.strike, 25_050)
})

test('flyPlan: an iron fly at ATM, wings max(pb_wing_min_steps, round(pb_wing_str_k x STR / step)) steps out, each short covered by its own type', () => {
  const { tape, chain } = market()
  const str = atmStraddleMid(chain) ?? Number.NaN
  const fly = flyPlan(ctxOf(inputsAt(tape, NOW, { chain }), dialsOf({ pb_wing_str_k: 1.25, pb_wing_min_steps: 2 })))
  assert.ok(fly !== null)
  const w = Math.max(2, Math.round((1.25 * str) / 50))
  assert.equal(fly.centre, 25_000)
  assert.deepEqual(fly.protective.map((a) => [a.strike, a.optType, a.side, a.lots]), [
    [25_000 + w * 50, 'CE', 'Buy', 1],
    [25_000 - w * 50, 'PE', 'Buy', 1],
  ])
  assert.deepEqual(fly.shorts, [
    { strike: 25_000, optType: 'CE', cover: 25_000 + w * 50 },
    { strike: 25_000, optType: 'PE', cover: 25_000 - w * 50 },
  ])
  // The floor in steps holds when the straddle is cheap.
  const floored = flyPlan(ctxOf(inputsAt(tape, NOW, { chain }), dialsOf({ pb_wing_str_k: 0.01, pb_wing_min_steps: 4 })))
  assert.deepEqual(floored?.protective.map((a) => a.strike), [25_200, 24_800])
  // Wings past the edge of the board: no fly.
  assert.equal(flyPlan(ctxOf(inputsAt(tape, NOW, { chain }), dialsOf({ pb_wing_min_steps: 30 }))), null)
  // A short centre held long: no fly on it.
  const legs = [legOn(chain, 25_000, 'PE', 'Buy', 1)]
  assert.equal(flyPlan(ctxOf(inputsAt(tape, NOW, { chain, legs }), DIALS)), null)
})

// ── debounces ───────────────────────────────────────────────────────────────

test('held: the index-stop debounce stamps on the first pass, fires once the hold has run, and resets the moment the condition clears', () => {
  const { tape, chain } = market()
  const ctx = (ms: number, since: number) => ctxOf(inputsAt(tape, ms, { chain }), DIALS, { condSinceMs: since })
  assert.deepEqual(held(ctx(NOW, 0), false, 20), { fire: false, patch: { condSinceMs: 0 } })
  assert.deepEqual(held(ctx(NOW, 0), true, 20), { fire: false, patch: { condSinceMs: NOW } }, 'first pass: stamp, no fire')
  assert.deepEqual(held(ctx(NOW + 19_999, NOW), true, 20), { fire: false, patch: { condSinceMs: NOW } })
  assert.deepEqual(held(ctx(NOW + 20_000, NOW), true, 20), { fire: true, patch: { condSinceMs: NOW } }, 'inclusive at the hold')
  assert.deepEqual(held(ctx(NOW + 25_000, NOW), false, 20), { fire: false, patch: { condSinceMs: 0 } }, 'cleared: reset')
  assert.equal(held(ctx(NOW, 0), true, 0).fire, true, 'a hold of 0 fires at once')
})

test('heldRupee: the rupee debounce shares rupeeSinceMs with the frame, and says nothing when its own condition is off', () => {
  const { tape, chain } = market()
  const ctx = (ms: number, since: number) => ctxOf(inputsAt(tape, ms, { chain }), DIALS, { rupeeSinceMs: since })
  assert.deepEqual(heldRupee(ctx(NOW, 0), true), { fire: false, patch: { rupeeSinceMs: NOW } })
  assert.deepEqual(heldRupee(ctx(NOW + 3_000, NOW), true), { fire: true, patch: { rupeeSinceMs: NOW } }, 'pb_rupee_hold_s 3')
  assert.deepEqual(heldRupee(ctx(NOW + 1_000, NOW - 5_000), true, 10), { fire: false, patch: { rupeeSinceMs: NOW - 5_000 } })
  // Off: no opinion. The frame resets the shared clock when NOTHING holds.
  assert.deepEqual(heldRupee(ctx(NOW, NOW - 1_000), false), { fire: false, patch: {} })
})

// ── the tape over a window ──────────────────────────────────────────────────

test('windowRange: the filtered high and low of a covered window — a spike outvoted, a hole or a thin tape refused', () => {
  const tape = new Tape((ms) => OPEN + (ms - at(555)) / 60_000) // +1 point a minute
  tape.advanceTo(at(600))
  const t0 = at(570)
  const t1 = at(600)
  const ctx = ctxOf(inputsAt(tape, at(600)), DIALS)
  const r = windowRange(ctx, t0, t1)
  assert.ok(r !== null)
  assert.ok(Math.abs(r.lo - (OPEN + 15)) < 0.05 && Math.abs(r.hi - (OPEN + 45)) < 0.05, JSON.stringify(r))

  // One bad print inside the window never becomes its high.
  const spiky = new Tape((ms) => (ms === at(590) ? OPEN + 500 : OPEN + (ms - at(555)) / 60_000))
  spiky.advanceTo(at(600))
  const s = windowRange(ctxOf(inputsAt(spiky, at(600)), DIALS), t0, t1)
  assert.ok(s !== null && s.hi < OPEN + 46, `the spike leaked: ${JSON.stringify(s)}`)

  // A 5-minute hole in a 30-minute window is 17% uncovered.
  const holed = new Tape()
  holed.advanceTo(at(580))
  holed.skipTo(at(585))
  holed.advanceTo(at(600))
  assert.equal(windowRange(ctxOf(inputsAt(holed, at(600)), DIALS), t0, t1), null)
  // Coverage of only the last 20 minutes of a 30-minute window.
  const late = new Tape(undefined, at(580))
  late.advanceTo(at(600))
  assert.equal(windowRange(ctxOf(inputsAt(late, at(600)), DIALS), t0, t1), null)
  assert.ok(windowRange(ctxOf(inputsAt(late, at(600)), DIALS), t0, t1, 0.6) !== null, 'a looser bar takes it')
  // Fewer than eight prints is not a window at all.
  const sparse = new Tape(undefined, at(570), 300_000)
  sparse.advanceTo(at(600))
  assert.equal(windowRange(ctxOf(inputsAt(sparse, at(600)), DIALS), t0, t1), null)
  assert.equal(windowRange(ctx, t1, t0), null, 'an inverted window')
})

// ── values and sides ────────────────────────────────────────────────────────

test('shortsValue: the shorts at their ask against their entry; null when a short has no ask, or there are no shorts', () => {
  const { chain } = market()
  const s1 = legOn(chain, 25_000, 'CE', 'Sell', 2, { entry: 100 })
  const s2 = legOn(chain, 25_000, 'PE', 'Sell', 1, { entry: 80 })
  const w = legOn(chain, 25_250, 'CE', 'Buy', 2, { entry: 30 })
  const v = shortsValue([s1, s2, w])
  assert.ok(v !== null)
  const ask = (l: typeof s1): number => l.exit.ask ?? Number.NaN
  assert.ok(Math.abs(v.now - (ask(s1) * 2 * 65 + ask(s2) * 65)) < 1e-6)
  assert.equal(v.entry, 100 * 2 * 65 + 80 * 65)
  assert.equal(shortsValue([s1, { ...s2, exit: { ...s2.exit, ask: null, bid: null } }]), null)
  assert.equal(shortsValue([w]), null, 'no shorts: no reading, never a zero that a stop could compare against')
})

test('debitSpreadMax: width x lots x lot size less the debit, for one whole debit pair — null for any other shape', () => {
  const { chain } = market()
  const call = (long: number, short: number, longLots = 2, shortLots = 2) => [
    legOn(chain, long, 'CE', 'Buy', longLots, { entry: 120 }),
    legOn(chain, short, 'CE', 'Sell', shortLots, { entry: 40 }),
  ]
  // (200 - 80) x 2 lots of 65.
  assert.equal(debitSpreadMax(call(24_950, 25_150)), 120 * 130)
  // The put pair is the mirror: bought above, sold below.
  const put = [legOn(chain, 25_100, 'PE', 'Buy', 1, { entry: 110 }), legOn(chain, 24_900, 'PE', 'Sell', 1, { entry: 30 })]
  assert.equal(debitSpreadMax(put), (200 - 80) * 65)
  // A pyramid's extra long, a short not all held, a credit pair, a third leg,
  // a lone long, a long and a short of different types: no ceiling to name.
  assert.equal(debitSpreadMax(call(24_950, 25_150, 3, 2)), null)
  assert.equal(debitSpreadMax(call(24_950, 25_150, 2, 1)), null)
  assert.equal(debitSpreadMax(call(25_150, 24_950)), null, 'long further out: a credit pair')
  assert.equal(debitSpreadMax([...call(24_950, 25_150), legOn(chain, 24_850, 'PE', 'Buy', 2, { entry: 20 })]), null)
  assert.equal(debitSpreadMax([legOn(chain, 25_000, 'CE', 'Buy', 2, { entry: 90 })]), null)
  assert.equal(debitSpreadMax([legOn(chain, 25_000, 'CE', 'Buy', 2, { entry: 90 }), legOn(chain, 25_100, 'PE', 'Sell', 2, { entry: 40 })]), null)
})

test('trendSide reads only the two trends', () => {
  assert.equal(trendSide('trend-up'), 'up')
  assert.equal(trendSide('trend-down'), 'down')
  for (const r of ['quiet', 'chop', 'unknown'] as const) assert.equal(trendSide(r), null)
})

test('d2Close: every short bought back first; the longs only once no short is held', () => {
  const { chain } = market()
  const long = legOn(chain, 24_950, 'CE', 'Buy', 2)
  const short = legOn(chain, 25_150, 'CE', 'Sell', 2)
  const wing = legOn(chain, 24_750, 'PE', 'Buy', 2)
  assert.deepEqual(d2Close([long, short, wing]), [{ op: 'close', instrument: short.instrument }])
  assert.deepEqual(d2Close([long, wing]), [
    { op: 'close', instrument: long.instrument },
    { op: 'close', instrument: wing.instrument },
  ])
  assert.deepEqual(d2Close([]), [])
})
