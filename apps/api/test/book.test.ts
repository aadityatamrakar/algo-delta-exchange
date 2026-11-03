import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import type { InstrumentRef } from '@algomaker/order-bus'
import { applyActions, applyRoutedFill, diffBooks, type ApplyContext } from '../src/book.ts'
import type { BridgeLeg, DeskAction, MarkSource } from '../src/contract.ts'

const EXPIRY = '2026-07-28'
const UNDERLYING = 'KALYANKJIL'
const NOW = Date.UTC(2026, 6, 14, 5, 0)

function master(strikes: readonly number[] = [495, 500, 505, 510, 530, 535, 540, 545]): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of strikes) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: 900000 + strike * 10 + (type === 'CE' ? 1 : 2),
        tradingsymbol: `KALYANKJIL26JUL${strike}${type}`,
        name: UNDERLYING,
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: 1350,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  return new OptionMaster(rows)
}

/** Every contract marks at 10 unless overridden; `null` means "feed has nothing". */
function marks(overrides: Record<string, number | null> = {}, dflt: number | null = 10): MarkSource {
  return {
    price(i: InstrumentRef): number | null {
      const o = overrides[i.tradingsymbol]
      return o === undefined ? dflt : o
    },
    spot(): number | null {
      return 521
    },
  }
}

function ctx(over: Partial<ApplyContext> = {}): ApplyContext {
  return {
    master: master(),
    marks: marks(),
    nowMs: NOW,
    underlying: UNDERLYING,
    expiry: EXPIRY,
    ...over,
  }
}

const openAct = (ts: string, strike: number, type: 'CE' | 'PE', qty = 6750): DeskAction => ({
  op: 'open', ts, strike, type, side: 'Sell', qty,
})

test('open books a short leg against the REAL contract, signed negative', () => {
  const r = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  assert.equal(r.skips.length, 0)
  assert.equal(r.book.length, 1)
  const leg = r.book[0]!
  assert.equal(leg.deskTag, 'CE530#0')
  assert.equal(leg.instrument.tradingsymbol, 'KALYANKJIL26JUL530CE')
  assert.equal(leg.instrument.lotSize, 1350)
  assert.equal(leg.qty, -6750, 'a Sell must be stored negative so legs sum without a side lookup')
  assert.equal(r.fills.length, 1)
  assert.equal(r.fills[0]?.op, 'open')
})

test('an unlisted strike is SKIPPED with a reason, and the rest of the decision still applies', () => {
  const actions = [
    openAct('CE530#0', 530, 'CE'),
    openAct('CE525#1', 525, 'CE'), // 525 is not listed in this chain
    openAct('PE510#2', 510, 'PE'),
  ]
  const r = applyActions([], actions, ctx())
  assert.equal(r.book.length, 2, 'the two listed legs must still be booked')
  assert.equal(r.skips.length, 1)
  assert.match(r.skips[0]!.reason, /not a listed contract/)
  assert.deepEqual(r.book.map((l) => l.deskTag), ['CE530#0', 'PE510#2'])
})

test('a missing mark skips rather than booking at a fabricated price', () => {
  const r = applyActions(
    [],
    [openAct('CE530#0', 530, 'CE')],
    ctx({ marks: marks({ KALYANKJIL26JUL530CE: null }) }),
  )
  assert.equal(r.book.length, 0)
  assert.match(r.skips[0]!.reason, /no mark/)
})

test('duplicate open tags are refused — they would make later closes ambiguous', () => {
  const first = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const second = applyActions(first.book, [openAct('CE530#0', 535, 'CE')], ctx())
  assert.equal(second.book.length, 1)
  assert.match(second.skips[0]!.reason, /already open/)
})

/**
 * AN OPEN THE CALLER MARKED AS AN ADD.
 *
 * The recenter shed accumulates: it re-picks the best strike and sells more of
 * it, which the legacy implementation expressed as a plain `open` and a broker
 * simply netted. Refusing that cost six days of skipped decisions across three
 * books (2026-09-16).
 *
 * BUT "open X" ALONE CANNOT MEAN BOTH "add" and "repeat", and the test above
 * pins the second reading: a repeated decision must NEVER silently double a
 * position. So the intent travels explicitly, set by the shed, and only a
 * marked open merges. Everything unmarked is refused exactly as before.
 *
 * MERGING KEEPS THE GUARD'S REAL GUARANTEE — its fear is two legs sharing a
 * deskTag, and adding to the existing leg leaves exactly one.
 */
test('an open MARKED as an add grows the existing leg instead of being refused', () => {
  const first = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const second = applyActions(
    first.book,
    [{ op: 'open' as const, ts: 'CE530#0', strike: 530, type: 'CE' as const, side: 'Sell' as const, qty: 2700, add: true }],
    ctx({ marks: marks({ KALYANKJIL26JUL530CE: 16 }) }),
  )

  assert.deepEqual(second.skips, [], 'a marked add must not be skipped')
  assert.equal(second.book.length, 1, 'still ONE leg for the tag')
  const leg = second.book[0]!
  assert.equal(leg.qty, -9450, '6750 + 2700, still signed negative for a short')
  // Weighted average, as a broker nets it: (6750x10 + 2700x16) / 9450.
  assert.ok(
    Math.abs(leg.entryPrice - (6750 * 10 + 2700 * 16) / 9450) < 1e-9,
    `entry must be the weighted average, got ${leg.entryPrice}`,
  )
  // The ORDER is still a fresh sale of 2700 — the merge is a fact about the
  // leg, not a claim about what went to the broker.
  assert.equal(second.fills.length, 1)
  assert.equal(second.fills[0]?.qty, 2700)
})

test('an UNMARKED open on a held contract is still refused — the never-doubled rule', () => {
  // This is the invariant `engine-decisions.test.ts` pins: a decision that
  // repeats must not grow the book. Only an explicit add may.
  const first = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const second = applyActions(first.book, [openAct('CE530#0', 530, 'CE')], ctx())
  assert.equal(second.book.length, 1)
  assert.equal(second.book[0]!.qty, -6750, 'unchanged')
  assert.match(second.skips[0]!.reason, /already open/)
})

test('a marked add naming a DIFFERENT contract is refused, flag or no flag', () => {
  // The tag would then name two contracts and no later close could say which.
  // The flag says "add to it", not "whatever you find under this name".
  const first = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const second = applyActions(
    first.book,
    [{ op: 'open' as const, ts: 'CE530#0', strike: 535, type: 'CE' as const, side: 'Sell' as const, qty: 2700, add: true }],
    ctx(),
  )
  assert.equal(second.book.length, 1)
  assert.equal(second.book[0]!.qty, -6750, 'unchanged')
  assert.match(second.skips[0]!.reason, /already open/)
})

test('a marked add on the OPPOSITE side is refused', () => {
  // Buying into a short reduces it and, past its size, flips it through zero.
  // That is a different operation with a different sign; `close` and `resize`
  // exist to say it.
  const first = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const second = applyActions(
    first.book,
    [{ op: 'open', ts: 'CE530#0', strike: 530, type: 'CE', side: 'Buy', qty: 1350, add: true }],
    ctx(),
  )
  assert.equal(second.book.length, 1)
  assert.equal(second.book[0]!.qty, -6750, 'unchanged')
  assert.match(second.skips[0]!.reason, /already open/)
})

test('close removes the leg and fills on the OPPOSITE side', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const r = applyActions(opened.book, [{ op: 'close', ts: 'CE530#0' }], ctx())
  assert.equal(r.book.length, 0)
  assert.equal(r.fills.length, 1)
  assert.equal(r.fills[0]?.side, 'Buy', 'closing a short must BUY')
  assert.equal(r.fills[0]?.qty, 6750)
})

test('close of an unknown tag is skipped, never silently ignored', () => {
  const r = applyActions([], [{ op: 'close', ts: 'GHOST#9' }], ctx())
  assert.equal(r.skips.length, 1)
  assert.match(r.skips[0]!.reason, /unknown leg/)
})

test('roll replaces the leg in place, re-tags it, and emits BOTH fills', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const r = applyActions(
    opened.book,
    [{ op: 'roll', ts: 'CE530#0', to_ts: 'CE540#0', to_strike: 540 }],
    ctx(),
  )
  assert.equal(r.skips.length, 0)
  assert.equal(r.book.length, 1)
  const leg = r.book[0]!
  assert.equal(leg.deskTag, 'CE540#0')
  assert.equal(leg.strike, 540)
  assert.equal(leg.instrument.tradingsymbol, 'KALYANKJIL26JUL540CE')
  assert.equal(leg.qty, -6750, 'a roll must preserve size and side')
  assert.equal(r.fills.length, 2)
  assert.deepEqual(r.fills.map((f) => f.side), ['Buy', 'Sell'])
})

test('a roll with only one side marked is refused outright, not half-booked', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const r = applyActions(
    opened.book,
    [{ op: 'roll', ts: 'CE530#0', to_ts: 'CE540#0', to_strike: 540 }],
    ctx({ marks: marks({ KALYANKJIL26JUL540CE: null }) }),
  )
  assert.equal(r.fills.length, 0, 'half a roll leaves the book naked with no record of why')
  assert.equal(r.book[0]?.deskTag, 'CE530#0', 'the original leg must survive untouched')
  assert.match(r.skips[0]!.reason, /missing mark/)
})

test('roll to an unlisted strike leaves the original leg alone', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const r = applyActions(
    opened.book,
    [{ op: 'roll', ts: 'CE530#0', to_ts: 'CE525#0', to_strike: 525 }],
    ctx(),
  )
  assert.equal(r.book[0]?.strike, 530)
  assert.match(r.skips[0]!.reason, /not a listed contract/)
})

test('resize takes an ABSOLUTE quantity and trades only the difference', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE', 6750)], ctx())
  const grown = applyActions(opened.book, [{ op: 'resize', ts: 'CE530#0', qty: 9450 }], ctx())
  assert.equal(grown.book[0]?.qty, -9450)
  assert.equal(grown.fills[0]?.qty, 2700, 'only the delta trades')
  assert.equal(grown.fills[0]?.side, 'Sell', 'growing a short SELLS more')

  const shrunk = applyActions(grown.book, [{ op: 'resize', ts: 'CE530#0', qty: 4050 }], ctx())
  assert.equal(shrunk.book[0]?.qty, -4050)
  assert.equal(shrunk.fills[0]?.qty, 5400)
  assert.equal(shrunk.fills[0]?.side, 'Buy', 'shrinking a short BUYS back')
})

test('resize to zero closes the leg out of the book', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const r = applyActions(opened.book, [{ op: 'resize', ts: 'CE530#0', qty: 0 }], ctx())
  assert.equal(r.book.length, 0)
  assert.equal(r.fills[0]?.qty, 6750)
})

test('resize to the same quantity is a genuine no-op, not a zero-qty fill', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE', 6750)], ctx())
  const r = applyActions(opened.book, [{ op: 'resize', ts: 'CE530#0', qty: 6750 }], ctx())
  assert.equal(r.fills.length, 0)
  assert.equal(r.skips.length, 0)
  assert.equal(r.book[0]?.qty, -6750)
})

test('an unsupported op is reported, not silently dropped', () => {
  const r = applyActions([], [{ op: 'hedge' } as unknown as DeskAction], ctx())
  assert.equal(r.skips.length, 1)
  assert.match(r.skips[0]!.reason, /unsupported op 'hedge'/)
})

test('the input book is never mutated', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const before = JSON.stringify(opened.book)
  applyActions(opened.book, [{ op: 'close', ts: 'CE530#0' }], ctx())
  assert.equal(JSON.stringify(opened.book), before)
})

test('the full 8-leg strangle ladder books in one decision', () => {
  const actions: DeskAction[] = [
    openAct('CE530#0', 530, 'CE'), openAct('CE535#1', 535, 'CE'),
    openAct('CE540#2', 540, 'CE'), openAct('CE545#3', 545, 'CE'),
    openAct('PE510#4', 510, 'PE'), openAct('PE505#5', 505, 'PE'),
    openAct('PE500#6', 500, 'PE'), openAct('PE495#7', 495, 'PE'),
  ]
  const r = applyActions([], actions, ctx())
  assert.equal(r.skips.length, 0)
  assert.equal(r.book.length, 8)
  assert.equal(r.book.reduce((s, l) => s + l.qty, 0), -54000)
})

// ------------------------------------------------------------------ D2 diff

const declared = (strike: number, type: string, qty: number) => ({ strike, type, qty })

test('diffBooks reports agreement without arbitrating', () => {
  const bridge = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx()).book
  const d = diffBooks([declared(530, 'CE', -6750)], bridge)
  assert.equal(d.inSync, true)
  assert.equal(d.matched.length, 1)
})

test('diffBooks surfaces a leg the desk thinks it has and we do not', () => {
  const bridge: readonly BridgeLeg[] = []
  const d = diffBooks([declared(530, 'CE', -6750)], bridge)
  assert.equal(d.inSync, false)
  assert.deepEqual(d.deskOnly, [{ strike: 530, type: 'CE', deskQty: -6750, bridgeQty: 0 }])
})

test('diffBooks surfaces a size mismatch as mismatched, not as two one-sided entries', () => {
  const bridge = applyActions([], [openAct('CE530#0', 530, 'CE', 6750)], ctx()).book
  const d = diffBooks([declared(530, 'CE', -9450)], bridge)
  assert.equal(d.mismatched.length, 1)
  assert.equal(d.mismatched[0]?.deskQty, -9450)
  assert.equal(d.mismatched[0]?.bridgeQty, -6750)
  assert.equal(d.deskOnly.length, 0)
  assert.equal(d.bridgeOnly.length, 0)
})

test('diffBooks matches on (strike,type), so a TAG desync still shows as in-sync', () => {
  // This is the point: tags drift across a process boundary (roll re-tagging,
  // a skipped action shifting Python's positional index). Positions are what
  // matter, so the diff must not report a false alarm when only tags differ.
  const bridge = applyActions([], [openAct('WEIRD-TAG', 530, 'CE')], ctx()).book
  const d = diffBooks([declared(530, 'CE', -6750)], bridge)
  assert.equal(d.inSync, true)
})

// ------------------------------------------------- folding a routed fill in

/**
 * `desk-books` used to be written in exactly two places — the seed path and
 * `applyActions` — so neither `/v1/desk/submit` (the Build screen's Place) nor
 * `close-all` (the UI's Flatten) maintained it. Flattening BHEL on 2026-07-31
 * left the order log correctly reading "0 open, 2 closed" while the book still
 * recorded the opening BUYs: the Positions page drew two legs that no longer
 * existed, delta and P&L were computed off them, and the book could not be
 * deleted because the delete guard reads the same record.
 */
const FILL_INSTRUMENT: InstrumentRef = {
  tradingsymbol: 'BHEL26AUG430CE',
  instrumentToken: 19674882,
  lotSize: 2625,
  tickSize: 0.05,
  exchange: 'NFO',
}

function routed(over: Partial<Parameters<typeof applyRoutedFill>[1]> = {}) {
  return {
    instrument: FILL_INSTRUMENT,
    underlying: 'BHEL',
    expiry: '2026-08-25',
    strike: 430,
    type: 'CE' as const,
    side: 'Buy' as const,
    qty: 10500,
    price: 8,
    ts: 1,
    deskTag: 'entry-BHEL#0',
    ...over,
  }
}

test('a fill on a contract the book does not hold opens the leg', () => {
  const book = applyRoutedFill([], routed())
  assert.equal(book.length, 1)
  assert.equal(book[0]?.qty, 10500)
  assert.equal(book[0]?.entryPrice, 8)
  assert.equal(book[0]?.instrument.tradingsymbol, 'BHEL26AUG430CE')
})

test('the closing fill REMOVES the leg rather than leaving it at zero', () => {
  // The BHEL flatten, exactly. Every consumer counts legs.length to mean "does
  // this hold anything" — the delete guard included — so a zero-qty leg would
  // keep the book undeletable and keep drawing a position that is gone.
  const opened = applyRoutedFill([], routed())
  const flat = applyRoutedFill(opened, routed({ side: 'Sell', price: 7.5, deskTag: 'ui-flatten#0' }))
  assert.deepEqual(flat, [])
})

test('a close is matched by CONTRACT, not by the tag it was routed under', () => {
  // `close-all` generates its own `ui-flatten-...` tag, which never equals the
  // tag the leg was opened under. Matching on it would append an opposite leg.
  const opened = applyRoutedFill([], routed({ deskTag: 'entry-BHEL#0' }))
  const after = applyRoutedFill(opened, routed({ side: 'Sell', deskTag: 'totally-different' }))
  assert.equal(after.length, 0)
})

test('a PARTIAL close reduces the leg and leaves its cost basis alone', () => {
  const opened = applyRoutedFill([], routed({ qty: 10500, price: 8 }))
  const half = applyRoutedFill(opened, routed({ side: 'Sell', qty: 5250, price: 7.5 }))
  assert.equal(half[0]?.qty, 5250)
  assert.equal(half[0]?.entryPrice, 8, 'closing half must not restate what the rest cost')
})

test('adding to a leg re-averages the entry price by size', () => {
  const one = applyRoutedFill([], routed({ qty: 1000, price: 10 }))
  const two = applyRoutedFill(one, routed({ qty: 3000, price: 6 }))
  assert.equal(two[0]?.qty, 4000)
  assert.equal(two[0]?.entryPrice, 7, '(1000*10 + 3000*6) / 4000')
})

test('a fill that crosses through zero closes the leg and APPENDS the new side', () => {
  // This test used to pin the defect: the fold flipped the matched leg's `side`
  // in place. Flipping is exactly what F-26 forbids — with two same-contract
  // legs it turns a netted close into two phantom positions. The aggregate
  // behaviour survives (a book that was +1000 and sold 2500 IS -1500 short),
  // but it is expressed as "the long is consumed, the short is a NEW leg":
  // one leg, the fill's side, and the fill's own price as the cost basis of a
  // position that was opened by this fill and by nothing else.
  const long = applyRoutedFill([], routed({ qty: 1000 }))
  const short = applyRoutedFill(long, routed({ side: 'Sell', qty: 2500, price: 9, deskTag: 'flip#0' }))
  assert.equal(short.length, 1)
  assert.equal(short[0]?.qty, -1500)
  assert.equal(short[0]?.side, 'Sell')
  assert.equal(short[0]?.entryPrice, 9, 'the new short cost what THIS fill sold at')
  assert.equal(short[0]?.deskTag, 'flip#0')
})

// ------------------------------------------------- F-26: many legs, one fill

/**
 * A book legally holds the SAME contract on several legs — `recenter-relief`
 * (`service.ts:870-874`) buys one contract back on one leg while another leg
 * still carries it — and `planFlatten` nets those legs into ONE order per
 * contract. The old fold found the FIRST matching leg and folded the whole
 * netted quantity into it, flipping its side: SELL 500 + SELL 500 closed by
 * BUY 1000 left `[Buy 500, Sell 500]`, two phantom legs, and `closeLeg` would
 * then route two more REAL orders against a position that no longer existed.
 */
function shortLeg(deskTag: string, qty: number, entryPrice = 8): BridgeLeg {
  return {
    deskTag,
    instrument: FILL_INSTRUMENT,
    underlying: 'BHEL',
    expiry: '2026-08-25',
    strike: 430,
    type: 'CE',
    side: qty < 0 ? 'Sell' : 'Buy',
    qty,
    entryPrice,
    openedTs: 1,
  }
}

test('a netted close consumes ACROSS both same-contract legs and flips neither', () => {
  const book = [shortLeg('t1', -500), shortLeg('t2', -500)]
  const after = applyRoutedFill(book, routed({ side: 'Buy', qty: 1000, price: 7 }))
  assert.deepEqual(after, [], 'both legs are closed — the book holds nothing')
})

test('a PARTIAL netted close consumes the legs in order, leaving the remainder on the later one', () => {
  const book = [shortLeg('t1', -500), shortLeg('t2', -500, 9)]
  const after = applyRoutedFill(book, routed({ side: 'Buy', qty: 700, price: 7 }))
  assert.equal(after.length, 1)
  assert.equal(after[0]?.deskTag, 't2')
  assert.equal(after[0]?.qty, -300)
  assert.equal(after[0]?.side, 'Sell', 'a reduced leg NEVER changes side')
  assert.equal(after[0]?.entryPrice, 9, 'a partial close does not restate what the rest cost')
})

test('a close larger than every matching leg appends ONE new leg, never flips one', () => {
  const book = [shortLeg('t1', -500), shortLeg('t2', -500)]
  const after = applyRoutedFill(book, routed({ side: 'Buy', qty: 1300, price: 7, deskTag: 'over#0' }))
  assert.equal(after.length, 1)
  assert.equal(after[0]?.qty, 300)
  assert.equal(after[0]?.side, 'Buy')
  assert.equal(after[0]?.deskTag, 'over#0')
  assert.equal(after[0]?.entryPrice, 7)
})

test('a SAME-side fill still re-averages the first matching leg and adds no leg', () => {
  const book = [shortLeg('t1', -500, 8), shortLeg('t2', -500, 8)]
  const after = applyRoutedFill(book, routed({ side: 'Sell', qty: 500, price: 6 }))
  assert.equal(after.length, 2)
  assert.equal(after[0]?.qty, -1000)
  assert.equal(after[0]?.entryPrice, 7, '(500*8 + 500*6) / 1000')
  assert.equal(after[1]?.qty, -500, 'the other leg is untouched')
})

test('a reducing fill consumes the OPPOSITE-side leg and leaves the same-side one alone', () => {
  // A mixed book — one long leg and one short leg on the same contract — is
  // what `recenter-relief` produces mid-repair. A sell must eat the long
  // before it can grow the short; the reverse would report more gross exposure
  // than the desk actually holds.
  const book = [shortLeg('t1', 400, 8), shortLeg('t2', -500, 9)]
  const after = applyRoutedFill(book, routed({ side: 'Sell', qty: 400, price: 7 }))
  assert.equal(after.length, 1)
  assert.equal(after[0]?.deskTag, 't2')
  assert.equal(after[0]?.qty, -500)
  assert.equal(after[0]?.entryPrice, 9)
})

test('a zero-quantity fill changes nothing', () => {
  const book = applyRoutedFill([], routed())
  assert.deepEqual(applyRoutedFill(book, routed({ qty: 0 })), book)
})

test('two different contracts are two different legs', () => {
  const ce = applyRoutedFill([], routed())
  const both = applyRoutedFill(ce, routed({
    instrument: { ...FILL_INSTRUMENT, tradingsymbol: 'BHEL26AUG400PE', instrumentToken: 19660546 },
    strike: 400, type: 'PE',
  }))
  assert.equal(both.length, 2)
})

// ------------------------------ the stale-mark ceiling on NEW exposure (F-16)

/** Marks that price everything at 10 and report every quote as `ageMs` old. */
function agedMarks(ageMs: number, dflt: number | null = 10): MarkSource {
  return {
    price(): number | null {
      return dflt
    },
    spot(): number | null {
      return 521
    },
    markAge(): number | null {
      return ageMs
    },
  }
}

const TEN_MIN = 600_000

test('an OPEN priced off an 11-minute-old mark is refused', () => {
  const r = applyActions(
    [],
    [openAct('CE530#0', 530, 'CE')],
    ctx({ marks: agedMarks(660_000), maxOpenMarkAgeMs: TEN_MIN }),
  )
  assert.equal(r.book.length, 0)
  assert.equal(r.fills.length, 0)
  assert.equal(r.skips.length, 1)
  assert.match(r.skips[0]!.reason, /refusing to price NEW exposure/)
  assert.match(r.skips[0]!.reason, /DESK_MAX_OPEN_MARK_AGE_MS/)
})

test('a CLOSE against that SAME stale mark still books — an exit is never trapped', () => {
  // The governing rule from safety.ts: a control that stops new exposure must
  // never block getting out. An uncontrolled exit price is bad; no exit is
  // worse, and the position keeps moving either way.
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const stale = ctx({ marks: agedMarks(660_000), maxOpenMarkAgeMs: TEN_MIN })
  const closed = applyActions(opened.book, [{ op: 'close', ts: 'CE530#0' }], stale)
  assert.equal(closed.skips.length, 0)
  assert.equal(closed.book.length, 0)
  assert.equal(closed.fills[0]?.side, 'Buy')
})

test('a ROLL against a stale mark still books — it is an exit that replaces itself', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx())
  const r = applyActions(
    opened.book,
    [{ op: 'roll', ts: 'CE530#0', to_ts: 'CE540#0', to_strike: 540 }],
    ctx({ marks: agedMarks(660_000), maxOpenMarkAgeMs: TEN_MIN }),
  )
  assert.equal(r.skips.length, 0)
  assert.equal(r.fills.length, 2)
  assert.equal(r.book[0]?.deskTag, 'CE540#0')
})

test('a GROWING resize is gated by the same ceiling; a SHRINKING one is not', () => {
  const opened = applyActions([], [openAct('CE530#0', 530, 'CE', 6750)], ctx())
  const stale = ctx({ marks: agedMarks(660_000), maxOpenMarkAgeMs: TEN_MIN })

  const grown = applyActions(opened.book, [{ op: 'resize', ts: 'CE530#0', qty: 9450 }], stale)
  assert.equal(grown.fills.length, 0)
  assert.equal(grown.book[0]?.qty, -6750, 'the leg is untouched')
  assert.match(grown.skips[0]!.reason, /refusing to price NEW exposure/)

  const shrunk = applyActions(opened.book, [{ op: 'resize', ts: 'CE530#0', qty: 4050 }], stale)
  assert.equal(shrunk.skips.length, 0)
  assert.equal(shrunk.book[0]?.qty, -4050)
  assert.equal(shrunk.fills[0]?.side, 'Buy')
})

test('a mark INSIDE the ceiling opens normally', () => {
  const r = applyActions(
    [],
    [openAct('CE530#0', 530, 'CE')],
    ctx({ marks: agedMarks(599_999), maxOpenMarkAgeMs: TEN_MIN }),
  )
  assert.equal(r.skips.length, 0)
  assert.equal(r.book.length, 1)
})

test('the ceiling is inert without a configured limit, and against a mark source with no ages', () => {
  // `StaticMarks` (dry runs, every test that does not opt in) implements no
  // `markAge`, so the gate must not turn an unknown age into a refusal.
  const unconfigured = applyActions([], [openAct('CE530#0', 530, 'CE')], ctx({ marks: agedMarks(999_999_999) }))
  assert.equal(unconfigured.book.length, 1, 'no ceiling configured means no gate')

  const ageless = applyActions(
    [],
    [openAct('CE531#0', 530, 'CE')],
    ctx({ marks: marks(), maxOpenMarkAgeMs: TEN_MIN }),
  )
  assert.equal(ageless.book.length, 1, 'an unknown age is not a stale age')
})

// ────────────────────────────────────────────────────── the delta-lean stamp

/**
 * A LEG THAT FORGOT WHICH BET OPENED IT.
 *
 * The delta-lean controller reads the P&L of the legs stamped with its current
 * lean id and adds size on a new peak, cuts on the drawdown from it, and stops
 * the whole lean on its own floor. `applyActions` is the writer that puts that
 * stamp on the leg; a leg that loses it belongs to no lean, so the lean reads as
 * holding nothing and NOTHING THROWS.
 */
test('an open carrying a lean id stamps the leg it creates', () => {
  const act: DeskAction = { op: 'open', ts: 'x#0', strike: 530, type: 'CE', side: 'Buy', qty: 1350, leanId: 'dl-up-123' }
  const r = applyActions([], [act], ctx())
  assert.equal(r.book.length, 1)
  assert.equal(r.book[0]?.leanId, 'dl-up-123')
})

test('an open with no lean id writes NO key — never `leanId: undefined`', () => {
  // Mongo stores an explicit undefined as null and reads it back as a VALUE, so
  // the supervisor's mapper would then find a null where it expects a string or
  // nothing at all. Absent has to stay absent, which is what every recenter open
  // and every legacy leg looks like.
  const r = applyActions([], [openAct('x#0', 530, 'CE')], ctx())
  assert.equal(r.book.length, 1)
  assert.equal('leanId' in (r.book[0] as object), false)
})

test('a close leaves the surviving legs` stamps alone', () => {
  // The stamp is the identity of a bet, not of an order: reducing one leg must
  // not restate which lean the others belong to, any more than it restates their
  // cost basis.
  const opened = applyActions(
    [],
    [
      { op: 'open', ts: 'a#0', strike: 530, type: 'CE', side: 'Buy', qty: 1350, leanId: 'dl-up-1' },
      { op: 'open', ts: 'b#0', strike: 540, type: 'CE', side: 'Sell', qty: 1350, leanId: 'dl-up-1' },
    ],
    ctx(),
  )
  const closed = applyActions(opened.book, [{ op: 'close', ts: 'b#0' }], ctx())
  assert.equal(closed.book.length, 1)
  assert.equal(closed.book[0]?.leanId, 'dl-up-1')
})
