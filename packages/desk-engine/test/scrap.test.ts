/**
 * THE SCRAP TIER AND ITS ENTRY GATE, ON A CHAIN THAT SOLVES.
 *
 * The ladder is `shed.test.ts`'s: 200…400 by 10 around spot 300, every strike
 * quoted at its Black-76 price at vol 0.30 with seven days to run, so a solve
 * returns the model's own delta. The three CE strikes that matter are the same
 * hand-derived ones:
 *
 *   310 CE  δ = 0.220826    320 CE  δ = 0.062601    330 CE  δ = 0.011489
 *
 * Two properties of this tier are worth naming before the assertions, because
 * both are measured lessons rather than design taste:
 *
 *   `hasGreeks: false` NEVER SCRAPS. TCS 2026-06-30: **72 of 100 scrap marks
 *   were zero-delta**, squaring off deep-ITM 2400 PEs against a ~2100 spot,
 *   because Python's `leg_greeks` zero-fills a leg the lake has no IV for and
 *   `0.0 < abs(d)` was the only thing standing between that and a close.
 *   `hasGreeks` is this engine's honest replacement for that sentinel and the
 *   tier reads it directly.
 *
 *   THE EXIT AND THE ENTRY MOVE TOGETHER. Phase R sizes its package
 *   `excess / (Δ × lot_size)`, so it demands its LARGEST packages exactly where
 *   delta is smallest. An exit-only dial would sell a low-delta package on one
 *   mark and scrap the whole thing on the next.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  RISK_FREE,
  scrapClose,
  scrapKey,
  sellGate,
  type ChainSnap,
  type Dials,
  type EngineAction,
  type EngineInputs,
  type LegView,
  type OptType,
  type Quote,
  type RuleState,
} from '@algomaker/desk-engine'
import { b76Price } from '@algomaker/greeks'

const DATE = '2026-08-21'
const EXPIRY = '2026-08-28'
const MINUTE = 600
const T7 = 7 / 365
const VOL = 0.3
const NOW = 1_755_000_000_000

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`. */
function bookAt(spot: number, strike: number, type: OptType, width = 0.02): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * (1 - width), px * (1 + width))
}

const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * 10)

function chainOf(over: ReadonlyMap<number, { ce?: Quote | null }> = new Map()): ChainSnap {
  return {
    symbol: 'TEST',
    expiry: EXPIRY,
    step: 10,
    lotSize: 25,
    future: q(299.5, 300.5),
    spot: 300,
    strikes: LADDER.map((k) => {
      const row = over.get(k)
      return {
        strike: k,
        ce: row !== undefined && 'ce' in row ? (row.ce ?? null) : bookAt(300, k, 'CE'),
        pe: bookAt(300, k, 'PE'),
      }
    }),
    asOf: NOW,
  }
}

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
    iv: VOL,
    delta: 0.220826,
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

function inputsOf(legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: NOW,
    dateIst: DATE,
    minuteOfDay: MINUTE,
    dte: 7,
    chain: chainOf(),
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

const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })

// ── the ban key ─────────────────────────────────────────────────────────────

test('the ban key is strike:wing:expiry, and a whole strike renders without a .0', () => {
  assert.equal(scrapKey(2400, 'PE', '2026-08-28'), '2400:PE:2026-08-28')
  assert.equal(scrapKey(2437.5, 'CE', '2026-08-28'), '2437.5:CE:2026-08-28')
  // PER EXPIRY: the same strike in the next series is a different contract and
  // is not banned by this one.
  assert.notEqual(scrapKey(2400, 'PE', '2026-08-28'), scrapKey(2400, 'PE', '2026-09-24'))
})

// ── the price arm ───────────────────────────────────────────────────────────

test('the price test reads the BID in live pricing, not the mid', () => {
  // Spec §6: what is LEFT in a spent short is what a buyer would pay for it.
  // This book's mid is 0.125 and its bid is 0.05 — at the 0.10 dial the two
  // readings disagree, and the bid is the one that scraps.
  const spent = leg({ exit: q(0.05, 0.2) })
  const out = scrapClose(inputsOf([spent]), dialsOf({ scrap_close_px: 0.1 }), EMPTY_RULE_STATE)
  assert.deepEqual(out?.actions, [{ op: 'close', instrument: spent.instrument }])
  assert.match(out?.reason ?? '', /scrap-close/)
  assert.match(out?.reason ?? '', /310CE@0\.05/)
})

test('the price test reads Python’s mid-or-LTP float in parity pricing', () => {
  // The same leg, the same dial, the other pricing mode: mid 0.125 is over 0.10
  // and the leg stays. This is the recorded-board reading and nothing else.
  const spent = leg({ exit: q(0.05, 0.2) })
  assert.equal(
    scrapClose(
      inputsOf([spent], { pricing: 'parity' }),
      dialsOf({ scrap_close_px: 0.1 }),
      EMPTY_RULE_STATE,
    ),
    null,
  )
})

test('at exactly the dial it scraps; a paise over, it stays', () => {
  const at = leg({ exit: q(0.1, 0.12) })
  const over = leg({ exit: q(0.11, 0.13) })
  const dials = dialsOf({ scrap_close_px: 0.1 })
  assert.equal(scrapClose(inputsOf([at]), dials, EMPTY_RULE_STATE)?.actions.length, 1)
  assert.equal(scrapClose(inputsOf([over]), dials, EMPTY_RULE_STATE), null)
})

test('a ZERO or ABSENT price is a missing mark, never a scrap', () => {
  // `engine.py:761` — "``ltp == 0`` is a MISSING mark, never a scrap". A quote
  // that has never been seen is the same case.
  const dials = dialsOf({ scrap_close_px: 0.1 })
  assert.equal(scrapClose(inputsOf([leg({ exit: q(0, 0) })]), dials, EMPTY_RULE_STATE), null)
  assert.equal(
    scrapClose(
      inputsOf([leg({ exit: { bid: null, ask: null, ltp: null, asOf: NOW } })]),
      dials,
      EMPTY_RULE_STATE,
    ),
    null,
  )
})

// ── the delta arm ───────────────────────────────────────────────────────────

test('the delta test is STRICT: at 0.15 exactly the leg stays', () => {
  // `engine.py:764-766`, and it is spelled out there: "at 0.15 exactly the leg
  // stays".
  const dials = dialsOf({ scrap_close_px: 0, scrap_close_delta: 0.15 })
  const at = leg({ delta: 0.15, exit: q(9, 11) })
  const under = leg({ delta: 0.149, exit: q(9, 11) })
  assert.equal(scrapClose(inputsOf([at]), dials, EMPTY_RULE_STATE), null)
  const out = scrapClose(inputsOf([under]), dials, EMPTY_RULE_STATE)
  assert.deepEqual(out?.actions, [{ op: 'close', instrument: under.instrument }])
  assert.match(out?.reason ?? '', /310CE@Δ0\.149/)
})

test('AN UNMARKED LEG NEVER SCRAPS — the TCS 2026-06-30 defect, by name', () => {
  // 72 of 100 scrap marks were zero-delta closes of deep-ITM 2400 PEs. A leg
  // whose IV did not solve carries `hasGreeks: false`, and no `delta` field it
  // happens to hold may be read as a signal.
  const dials = dialsOf({ scrap_close_px: 0, scrap_close_delta: 0.15 })
  const blind = leg({ strike: 2400, optType: 'PE', hasGreeks: false, delta: 0, exit: q(9, 11) })
  assert.equal(scrapClose(inputsOf([blind]), dials, EMPTY_RULE_STATE), null)
  // …including one whose stale delta would have passed the test.
  const stale = leg({ hasGreeks: false, delta: 0.05, exit: q(9, 11) })
  assert.equal(scrapClose(inputsOf([stale]), dials, EMPTY_RULE_STATE), null)
  // The PRICE test still takes it if it really is spent — no real scrap is lost.
  const spent = leg({ hasGreeks: false, delta: 0, exit: q(0.05, 0.07) })
  assert.equal(
    scrapClose(inputsOf([spent]), dialsOf({ scrap_close_px: 0.1 }), EMPTY_RULE_STATE)?.actions
      .length,
    1,
  )
})

test('both dials off is the whole tier off', () => {
  const spent = leg({ exit: q(0.01, 0.02), delta: 0.001 })
  assert.equal(
    scrapClose(inputsOf([spent]), dialsOf({ scrap_close_px: 0, scrap_close_delta: 0 }), EMPTY_RULE_STATE),
    null,
  )
})

test('a leg qualifying on BOTH tests is closed once, in one package', () => {
  const spent = leg({ exit: q(0.05, 0.07), delta: 0.01 })
  const out = scrapClose(
    inputsOf([spent]),
    dialsOf({ scrap_close_px: 0.1, scrap_close_delta: 0.15 }),
    EMPTY_RULE_STATE,
  )
  assert.equal(out?.actions.length, 1)
  // The price test wins the label, because it is checked first.
  assert.match(out?.reason ?? '', /@0\.05/)
  assert.match(out?.reason ?? '', /<= 0\.10\/share or \|Δ\| < 0\.15/)
})

test('LONGS are never scrapped — this tier squares off spent SHORTS', () => {
  const long = leg({ side: 'Buy', exit: q(0.05, 0.07) })
  assert.equal(scrapClose(inputsOf([long]), dialsOf({ scrap_close_px: 0.1 }), EMPTY_RULE_STATE), null)
})

// ── protection and the ban ──────────────────────────────────────────────────

test('protected quantity is exempt AT SELECTION, so the ban names only real closes', () => {
  // `engine.py:780-784`: filtering protection out downstream would ban a strike
  // this tier never squared off and name it in the reason — state recording a
  // close that never happened.
  const mine = leg({ strike: 320, exit: q(0.05, 0.07) })
  const theirs = leg({ strike: 330, exit: q(0.05, 0.07) })
  const out = scrapClose(
    inputsOf([mine, theirs], { protectedQty: { [theirs.instrument]: 4 } }),
    dialsOf({ scrap_close_px: 0.1 }),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out?.actions, [{ op: 'close', instrument: mine.instrument }])
  assert.deepEqual(out?.stateAfter.scrapBanned, [scrapKey(320, 'CE', EXPIRY)])
  assert.doesNotMatch(out?.reason ?? '', /330CE/)
})

test('a PARTLY protected leg scraps its steerable lots and resizes to the tail', () => {
  const part = leg({ lots: 5, exit: q(0.05, 0.07) })
  const out = scrapClose(
    inputsOf([part], { protectedQty: { [part.instrument]: 2 } }),
    dialsOf({ scrap_close_px: 0.1 }),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out?.actions, [{ op: 'resize', instrument: part.instrument, targetLots: 2 }])
})

test('the ban ACCUMULATES onto whatever the book already carried', () => {
  const prior: RuleState = { ...EMPTY_RULE_STATE, scrapBanned: ['999:PE:2026-08-28'] }
  const spent = leg({ strike: 320, exit: q(0.05, 0.07) })
  const out = scrapClose(inputsOf([spent]), dialsOf({ scrap_close_px: 0.1 }), prior)
  assert.deepEqual(out?.stateAfter.scrapBanned, ['999:PE:2026-08-28', '320:CE:2026-08-28'])
  // and re-scrapping the same strike does not duplicate the key.
  const again = scrapClose(inputsOf([spent]), dialsOf({ scrap_close_px: 0.1 }), out?.stateAfter ?? prior)
  assert.deepEqual(again?.stateAfter.scrapBanned, ['999:PE:2026-08-28', '320:CE:2026-08-28'])
})

// ── the sell gate ───────────────────────────────────────────────────────────

const sell = (strike: number, lots = 3): EngineAction => ({
  op: 'open',
  strike,
  optType: 'CE',
  side: 'Sell',
  lots,
})

test('a scrap-banned strike is stripped from the very next package', () => {
  // The pair that has to move together: the tier bans, the gate refuses.
  const spent = leg({ strike: 320, exit: q(0.05, 0.07) })
  const inputs = inputsOf([spent])
  const dials = dialsOf({ scrap_close_px: 0.1 })
  const scrapped = scrapClose(inputs, dials, EMPTY_RULE_STATE)
  assert.ok(scrapped !== null)

  const gate = sellGate(inputs, dials, scrapped.stateAfter, [sell(320), sell(330)])
  assert.deepEqual(gate.actions, [sell(330)])
  assert.deepEqual(gate.dropped, ['320CE (scrap-banned)'])
  assert.equal(gate.degradedToHold, false)
})

test('min_sell_px strips a paise premium, and reads the same side the scrap does', () => {
  const chain = chainOf(new Map([[330, { ce: q(0.05, 0.07) }]]))
  const inputs = inputsOf([leg()], { chain })
  const gate = sellGate(inputs, dialsOf({ min_sell_px: 0.1 }), EMPTY_RULE_STATE, [sell(330)])
  assert.deepEqual(gate.dropped, ['330CE (premium 0.05)'])
  assert.equal(gate.degradedToHold, true)

  // Off (0) is off — the default, and every recorded preset's setting.
  assert.deepEqual(
    sellGate(inputs, dialsOf({ min_sell_px: 0 }), EMPTY_RULE_STATE, [sell(330)]).actions,
    [sell(330)],
  )
})

test('min_sell_delta strips at or BELOW the dial — the entry side of the delta scrap', () => {
  // 330 CE solves to δ 0.011489 and 320 CE to 0.062601 (the header). A 0.05 gate
  // takes the first and leaves the second.
  const inputs = inputsOf([leg()])
  const gate = sellGate(inputs, dialsOf({ min_sell_delta: 0.05 }), EMPTY_RULE_STATE, [
    sell(320),
    sell(330),
  ])
  assert.deepEqual(gate.actions, [sell(320)])
  assert.equal(gate.dropped.length, 1)
  assert.match(gate.dropped[0] ?? '', /^330CE \(\|Δ\| 0\.011\)$/)

  // "dont sell 0.15 delta options" (user-directed 2026-07-30) — the 310 CE at
  // δ 0.220826 survives a 0.15 gate, the 320 CE at 0.062601 does not.
  const tighter = sellGate(inputs, dialsOf({ min_sell_delta: 0.15 }), EMPTY_RULE_STATE, [
    sell(310),
    sell(320),
  ])
  assert.deepEqual(tighter.actions, [sell(310)])
})

test('the gate FAILS OPEN on a measurement it cannot take', () => {
  // `engine.py:826-829`: a strike absent from the chain, or carrying no book,
  // is NOT dropped. Refusing everything unmeasurable turns a quiet chain into a
  // silent stand-down.
  const chain = chainOf(new Map([[330, { ce: null }]]))
  const inputs = inputsOf([leg()], { chain })
  const dials = dialsOf({ min_sell_px: 0.1, min_sell_delta: 0.15 })
  assert.deepEqual(sellGate(inputs, dials, EMPTY_RULE_STATE, [sell(330)]).actions, [sell(330)])
  // A strike that is not on the ladder at all is the same case.
  assert.deepEqual(sellGate(inputs, dials, EMPTY_RULE_STATE, [sell(3050)]).actions, [sell(3050)])
})

test('A ROLL DEGRADES TO ITS CLOSE, never to holding the tested short naked', () => {
  const spent = leg({ strike: 320, exit: q(0.05, 0.07) })
  const inputs = inputsOf([spent])
  const banned: RuleState = { ...EMPTY_RULE_STATE, scrapBanned: [scrapKey(330, 'CE', EXPIRY)] }
  const close: EngineAction = { op: 'close', instrument: spent.instrument }

  const gate = sellGate(inputs, dialsOf(), banned, [close, sell(330)])
  assert.deepEqual(gate.actions, [close])
  assert.equal(gate.degradedToHold, false)
})

test('an ALL-SELLS package with nothing worth selling degrades to a hold', () => {
  const banned: RuleState = {
    ...EMPTY_RULE_STATE,
    scrapBanned: [scrapKey(320, 'CE', EXPIRY), scrapKey(330, 'CE', EXPIRY)],
  }
  const gate = sellGate(inputsOf([leg()]), dialsOf(), banned, [sell(320), sell(330)])
  assert.equal(gate.degradedToHold, true)
  assert.deepEqual(gate.actions, [])
  assert.deepEqual(gate.dropped, ['320CE (scrap-banned)', '330CE (scrap-banned)'])
})

test('BUY opens and exits are never gated — this is a SELL gate', () => {
  const banned: RuleState = { ...EMPTY_RULE_STATE, scrapBanned: [scrapKey(330, 'CE', EXPIRY)] }
  const buy: EngineAction = { op: 'open', strike: 330, optType: 'CE', side: 'Buy', lots: 2 }
  const resize: EngineAction = { op: 'resize', instrument: 'X', targetLots: 1 }
  const gate = sellGate(inputsOf([leg()]), dialsOf(), banned, [buy, resize])
  assert.deepEqual(gate.actions, [buy, resize])
  assert.deepEqual(gate.dropped, [])
})

test('a package the gate does not touch comes back as the SAME array', () => {
  const actions = [sell(320)]
  const gate = sellGate(inputsOf([leg()]), dialsOf(), EMPTY_RULE_STATE, actions)
  assert.equal(gate.actions, actions)
  assert.deepEqual(gate.dropped, [])
})

// ── PORTED FROM PYTHON — `test_sim_recenter_scrap.py` and the scrap/sell-gate
//    block of `test_sim_rules.py`.

test('PORTED: the SIGN is ignored on both sides — the test is on the magnitude', () => {
  // `test_sign_is_ignored_on_both_sides`: a short PE carries POSITIVE leg delta
  // in the marked book and a short CE negative, so a rule reading the raw sign
  // would scrap one wing and never the other. `LegView.delta` is an unsigned
  // per-share magnitude precisely so this cannot happen (`types.ts:80`).
  const dials = dialsOf({ scrap_close_px: 0, scrap_close_delta: 0.15 })
  const ce = leg({ optType: 'CE', strike: 330, delta: 0.05 })
  const pe = leg({ optType: 'PE', strike: 270, delta: 0.05 })
  assert.equal(scrapClose(inputsOf([ce]), dials, EMPTY_RULE_STATE)?.actions.length, 1)
  assert.equal(scrapClose(inputsOf([pe]), dials, EMPTY_RULE_STATE)?.actions.length, 1)
})

test('PORTED: only the SPENT legs come off', () => {
  // `test_only_the_spent_legs_come_off`. A healthy short beside a spent one is
  // untouched — the tier picks victims, it does not flatten.
  const spent = leg({ strike: 330, exit: q(0.05, 0.07) })
  const alive = leg({ strike: 310, exit: q(4.4, 4.6) })
  const out = scrapClose(inputsOf([spent, alive]), dialsOf({ scrap_close_px: 0.1 }), EMPTY_RULE_STATE)
  assert.deepEqual(out?.actions, [{ op: 'close', instrument: spent.instrument }])
})

test('PORTED: a ZERO-SHARE leg is never a scrap', () => {
  // `test_zero_shares_is_never_a_scrap`: lots 0 → shares 0 → no per-share delta.
  // A degenerate leg is not squared off.
  const dials = dialsOf({ scrap_close_px: 0.1, scrap_close_delta: 0.15 })
  assert.equal(scrapClose(inputsOf([leg({ lots: 0, exit: q(0.05, 0.07) })]), dials, EMPTY_RULE_STATE), null)
})

test('PORTED: the scrap fires at ANY dte — min_sell_dte gates fresh SELLS, not the exit', () => {
  // `test_fires_at_any_dte`. Near expiry the whole book is held to expiry by the
  // sell ban, and a paise short is exactly what should NOT be held through it.
  const spent = leg({ exit: q(0.05, 0.07) })
  for (const dte of [0, 1, 20]) {
    const out = scrapClose(
      inputsOf([spent], { dte }),
      dialsOf({ scrap_close_px: 0.1, min_sell_dte: 1 }),
      EMPTY_RULE_STATE,
    )
    assert.equal(out?.actions.length, 1, `dte ${dte}`)
  }
})

test('PORTED: a price scrap and a delta scrap share ONE package', () => {
  // `test_price_and_delta_scraps_share_one_package`: two independent tests, one
  // close package per mark, one reason line — so the executor works one queue.
  const byPrice = leg({ strike: 330, exit: q(0.05, 0.07), delta: 0.4 })
  const byDelta = leg({ strike: 320, exit: q(4.4, 4.6), delta: 0.05 })
  const out = scrapClose(
    inputsOf([byPrice, byDelta]),
    dialsOf({ scrap_close_px: 0.1, scrap_close_delta: 0.15 }),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out?.actions, [
    { op: 'close', instrument: byPrice.instrument },
    { op: 'close', instrument: byDelta.instrument },
  ])
  assert.match(out?.reason ?? '', /330CE@0\.05/)
  assert.match(out?.reason ?? '', /320CE@Δ0\.050/)
  assert.deepEqual(out?.stateAfter.scrapBanned, [
    scrapKey(330, 'CE', EXPIRY),
    scrapKey(320, 'CE', EXPIRY),
  ])
})

test('PORTED: THE ASYMMETRY — 0.15 exactly is HELD on the way out and REFUSED on the way in', () => {
  // `test_the_entry_gate_is_at_or_below` next to `test_short_exactly_at_the_threshold_is_kept`.
  // The exit is `|Δ| < dial` and the entry is `|Δ| <= dial`, and the asymmetry is
  // deliberate: a leg already sold at 0.15 has earned most of its premium and is
  // worth keeping, while OPENING one at 0.15 is the trade the directive
  // ("dont sell 0.15 delta options", 2026-07-30) exists to refuse.
  const held = leg({ delta: 0.15, exit: q(4.4, 4.6) })
  assert.equal(
    scrapClose(inputsOf([held]), dialsOf({ scrap_close_px: 0, scrap_close_delta: 0.15 }), EMPTY_RULE_STATE),
    null,
    'the exit test is STRICT',
  )

  // The entry side, on a strike declared at EXACTLY 0.15 so the boundary is the
  // boundary and not a solver's eighth decimal.
  const declared = inputsOf([held], {
    pricing: 'parity',
    strikeGreeksOverride: () => ({ delta: 0.15, gamma: 0.02 }),
  })
  const refused = sellGate(declared, dialsOf({ min_sell_delta: 0.15 }), EMPTY_RULE_STATE, [sell(320)])
  assert.equal(refused.degradedToHold, true, 'the entry test is AT-OR-BELOW')
  assert.deepEqual(refused.dropped, ['320CE (|Δ| 0.150)'])

  // A hair above it, and the same strike sells.
  const sold = sellGate(declared, dialsOf({ min_sell_delta: 0.1499 }), EMPTY_RULE_STATE, [sell(320)])
  assert.deepEqual(sold.actions, [sell(320)])
})

test('PORTED: a chain delta zero-filled to 0.0 does NOT block a sell', () => {
  // `test_zero_chain_delta_does_not_block_a_sell`: the entry side of the same
  // guard the exit uses. An unmeasurable strike is a missing mark, and the gate
  // fails open on it rather than standing the book down.
  const inputs = inputsOf([leg()], { pricing: 'parity', strikeGreeksOverride: () => ({ delta: 0, gamma: 0 }) })
  const gate = sellGate(inputs, dialsOf({ min_sell_delta: 0.15 }), EMPTY_RULE_STATE, [sell(320)])
  assert.deepEqual(gate.actions, [sell(320)])
  assert.deepEqual(gate.dropped, [])
})

test('PORTED: the ban is PER EXPIRY — the next cycle’s same strike is sellable', () => {
  // `test_engine_sell_gate_blocks_scrap_banned_resell_even_at_fair_premium`:
  // "premium recovered" is not a reason to re-sell what decayed to paise once,
  // but the same strike in the NEXT series is a different contract.
  const banned: RuleState = { ...EMPTY_RULE_STATE, scrapBanned: [scrapKey(320, 'CE', EXPIRY)] }
  const thisCycle = sellGate(inputsOf([leg()]), dialsOf(), banned, [sell(320)])
  assert.equal(thisCycle.degradedToHold, true)
  assert.deepEqual(thisCycle.dropped, ['320CE (scrap-banned)'])

  const nextCycle: RuleState = {
    ...EMPTY_RULE_STATE,
    scrapBanned: [scrapKey(320, 'CE', '2026-09-24')],
  }
  const ok = sellGate(inputsOf([leg()]), dialsOf(), nextCycle, [sell(320)])
  assert.deepEqual(ok.actions, [sell(320)])
})
