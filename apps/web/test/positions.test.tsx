/**
 * A BOOK MAY HOLD ONE CONTRACT TWICE, and that is not a bug — it is how the
 * desk keeps two tranches separately closeable, because it closes by desk tag.
 * The positions table used to render it as two identical-looking rows, which
 * reads as duplication, and disagreed with the desk-vs-bridge panel below it
 * (that one groups by strike and type, so it said "4 legs" against five rows).
 *
 * These tests hold the display-side merge and the one property that makes it
 * safe to look at: the consolidated rows must still sum to the SAME net delta
 * the cards above the table show. A merge that averaged position delta, or that
 * kept only one tranche's greeks, passes a visual check and fails here.
 *
 * `.test.tsx` because the runner in this directory collects nothing else — see
 * `vitest.config.ts`. Most of what follows needs no DOM at all, which is the
 * point of `consolidatePositions` being a pure function.
 */
import { expect, test, describe, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  bookBreakevens, bookTotals, compareLadder, consolidatePositions, shortsOnlyGreeks,
  summaryRows, type PositionRow,
} from '../src/positions.ts'
import { PositionsPage } from '../src/pages.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type SentRequest } from './http.tsx'
import type { BookGreeks, BridgeLeg } from '../src/api.ts'

const TAG = 'ITC-2026-08-27-condor'

/**
 * One stored leg. `deskTag` differs per tranche — that is what keeps them
 * closeable apart.
 *
 * `strike` and `type` are OPTIONAL OVERRIDES with the old hardcoded defaults,
 * so the tests that predate row ordering keep their fixtures unchanged. The
 * ladder tests below set them, because that is the pair the order is derived
 * from — a fixture whose symbol says 280PE while its strike says 277.5 would
 * "pass" a sort test by accident.
 */
function leg(over: {
  deskTag: string
  tradingsymbol: string
  qty: number
  entryPrice: number
  strike?: number
  type?: BridgeLeg['type']
}): BridgeLeg {
  return {
    deskTag: over.deskTag,
    instrument: { tradingsymbol: over.tradingsymbol, instrumentToken: 1, lotSize: 1725 },
    underlying: 'ITC', expiry: '2026-08-27',
    strike: over.strike ?? 277.5, type: over.type ?? 'PE',
    side: over.qty < 0 ? 'Sell' : 'Buy', qty: over.qty, entryPrice: over.entryPrice, openedTs: 1,
  }
}

/** Per-leg greeks, one entry per STORED leg — the shape `bookGreeks` actually returns. */
function priced(over: { tradingsymbol: string; qty: number; delta: number }): BookGreeks['legs'][number] {
  return {
    tradingsymbol: over.tradingsymbol, qty: over.qty, iv: 0.22, price: 4.6,
    delta: over.delta, gamma: 0.02, vega: 1.4, theta: -0.9,
    positionDelta: over.delta * over.qty,
    positionGamma: 0.02 * over.qty, positionVega: 1.4 * over.qty, positionTheta: -0.9 * over.qty,
  }
}

function bookGreeks(legs: BookGreeks['legs'], unpriced: string[] = []): BookGreeks {
  const sum = (f: (l: BookGreeks['legs'][number]) => number): number => legs.reduce((a, l) => a + f(l), 0)
  return {
    legs,
    netDelta: sum((l) => l.positionDelta), netGamma: sum((l) => l.positionGamma),
    netVega: sum((l) => l.positionVega), netTheta: sum((l) => l.positionTheta),
    unpriced,
  }
}

describe('consolidatePositions', () => {
  test('two tranches of one contract become one row, at a size-weighted average entry', () => {
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
        leg({ deskTag: 'L4', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
      ],
      undefined,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.qty).toBe(-3450)
    expect(rows[0]?.entry).toBeCloseTo(4.575, 10)
    // Equal sizes make this the same as the plain mean; the next test is the
    // one that separates the two.
    expect(rows[0]?.fills).toBe(2)
  })

  test('the average is WEIGHTED BY SIZE, not a mean of the prices', () => {
    // A 10x fill at 4.70 and a 1x fill at 4.45 is a cost basis of 4.677, not
    // 4.575. The unweighted version is wrong by a quarter of a rupee on a leg
    // this size, and it is wrong in the direction of flattering the book.
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -17250, entryPrice: 4.7 }),
        leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
      ],
      undefined,
    )

    expect(rows[0]?.entry).toBeCloseTo((4.7 * 17250 + 4.45 * 1725) / 18975, 10)
    expect(rows[0]?.entry).not.toBeCloseTo(4.575, 3)
  })

  test('different contracts stay separate, in book order', () => {
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG282.5CE', qty: -17250, entryPrice: 6.45 }),
        leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG270PE', qty: -17250, entryPrice: 2.35 }),
        leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
        leg({ deskTag: 'L4', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
        leg({ deskTag: 'L5', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5 }),
      ],
      undefined,
    )

    expect(rows.map((r) => r.tradingsymbol)).toEqual([
      'ITC26AUG282.5CE', 'ITC26AUG270PE', 'ITC26AUG277.5PE', 'ITC26AUG280PE',
    ])
    // Four rows against five stored legs — which is exactly the count the
    // desk-vs-bridge panel reports, and why the page now agrees with itself.
    expect(rows.map((r) => r.fills)).toEqual([1, 1, 2, 1])
  })

  test('a lone leg passes through untouched — same qty, same entry, no merge to declare', () => {
    const rows = consolidatePositions(
      [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5 })],
      bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.31 })]),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tradingsymbol: 'ITC26AUG280PE', qty: -1725, entry: 5, fills: 1,
      mark: 4.6, iv: 0.22, delta: -0.31,
    })
    expect(rows[0]?.posDelta).toBeCloseTo(-0.31 * -1725, 10)
    expect(rows[0]?.entries).toEqual([5])
  })

  test('the consolidated position deltas sum to the book net delta, unchanged by merging', () => {
    /*
      THE PROPERTY THE WHOLE CHANGE RESTS ON. `greeks.legs` carries one entry
      per stored leg, so a contract held twice appears twice there; the old
      per-symbol Map kept only the LAST of them and every row of that contract
      then showed the last tranche's position delta. With unequal tranches the
      table stopped adding up to the Net delta card above it.
    */
    const legs = [
      leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG282.5CE', qty: -17250, entryPrice: 6.45 }),
      leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG277.5PE', qty: -17250, entryPrice: 4.7 }),
      leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
    ]
    const greeks = bookGreeks([
      priced({ tradingsymbol: 'ITC26AUG282.5CE', qty: -17250, delta: 0.28 }),
      priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -17250, delta: -0.34 }),
      priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.34 }),
    ])

    const rows = consolidatePositions(legs, greeks)
    const total = rows.reduce((a, r) => a + (r.posDelta ?? 0), 0)

    expect(total).toBeCloseTo(greeks.netDelta, 6)
    // And specifically NOT the last tranche's delta standing in for both.
    expect(rows[1]?.posDelta).toBeCloseTo(-0.34 * -18975, 6)
  })

  test('an unmarked contract keeps its flag and its null greeks on the merged row', () => {
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
        leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
      ],
      bookGreeks([], ['ITC26AUG277.5PE']),
    )

    expect(rows[0]?.unpriced).toBe(true)
    // Null, never 0: a leg with no mark is not a leg with no delta.
    expect(rows[0]?.posDelta).toBe(null)
    expect(rows[0]?.mark).toBe(null)
  })

  test('a fallback-priced contract is flagged modelPriced, with its estimate in the row', () => {
    // The TCS 2440PE case: deep ITM, LTP below the cash no-arb floor, no IV
    // solves — the bridge prices it theoretically and NAMES it. The row must
    // carry the flag so the table can say "model mark" instead of showing the
    // estimate as a market print.
    const g = bookGreeks([priced({ tradingsymbol: 'TCS26AUG2440PE', qty: -1125, delta: -0.9 })])
    const rows = consolidatePositions(
      [leg({ deskTag: 'L1', tradingsymbol: 'TCS26AUG2440PE', qty: -1125, entryPrice: 50.29 })],
      { ...g, fallbackPriced: ['TCS26AUG2440PE'] },
    )

    expect(rows[0]?.modelPriced).toBe(true)
    expect(rows[0]?.unpriced).toBe(false)
    expect(rows[0]?.mark).not.toBe(null)
    expect(rows[0]?.posDelta).toBeCloseTo(-0.9 * -1125, 6)
  })

  test('OPPOSITE directions on one contract stay two rows — a hedged pair is not "flat"', () => {
    // Netted into one row this rendered `Qty 0`, uncoloured because `sign(0)`
    // is undefined, reading as nothing held while both legs were open and
    // carrying margin and pin risk — at a blended entry no fill happened at.
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
        leg({ deskTag: 'L9', tradingsymbol: 'ITC26AUG277.5PE', qty: 1725, entryPrice: 6.0 }),
      ],
      undefined,
    )

    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.qty)).toEqual([-1725, 1725])
    expect(rows.map((r) => r.entry)).toEqual([4.7, 6.0])
  })

  test('same-direction tranches still merge — that is what this is for', () => {
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
        leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
      ],
      undefined,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.qty).toBe(-3450)
    expect(rows[0]?.entry).toBeCloseTo(4.575, 6)
  })

  test('every row carries its own P&L, and the rows sum to the book MTM', () => {
    /*
      THE PROPERTY THAT KEEPS THE COLUMN FROM BEING A FOURTH OPINION. The rows
      are merged and the book's MTM is not, so the two arithmetics meet only
      because a row holds ONE DIRECTION: with a single sign the |qty|-weighted
      entry satisfies `rowQty x avgEntry = Σ qᵢ·eᵢ` exactly. Merge across the
      sign and this drifts silently — by a rupee here, by a lakh on a real book.
    */
    const legs = [
      leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -17250, entryPrice: 4.7 }),
      leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
      leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG282.5CE', qty: -1725, entryPrice: 6.45, strike: 282.5, type: 'CE' }),
    ]
    const greeks = bookGreeks([
      priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -17250, delta: -0.34 }),
      priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.34 }),
      priced({ tradingsymbol: 'ITC26AUG282.5CE', qty: -1725, delta: 0.28 }),
    ])

    const rows = consolidatePositions(legs, greeks)

    // Both tranches at the helper's 4.60 mark: -17,250 x (4.60 − 4.70) is a
    // gain of 1,725 and -1,725 x (4.60 − 4.45) a loss of 258.75.
    expect(rows[0]?.pnl).toBeCloseTo(1466.25, 6)
    expect(rows[1]?.pnl).toBeCloseTo(3191.25, 6)

    const total = rows.reduce((a, r) => a + (r.pnl ?? 0), 0)
    expect(total).toBeCloseTo(bookTotals(legs, greeks, 279).mtm ?? 0, 6)
  })

  test('an unmarked contract has NO P&L — null, never a flat 0', () => {
    // The one case where a zero is most dangerous: it reads as a trade that has
    // gone nowhere, on the leg whose loss is the one thing nobody can see.
    const rows = consolidatePositions(
      [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 })],
      bookGreeks([], ['ITC26AUG277.5PE']),
    )

    expect(rows[0]?.pnl).toBe(null)
  })

  test('a fully closed contract averages rather than dividing by a zero weight', () => {
    // Σ|qty| of 0 would make the weighted formula NaN, which renders as an em
    // dash on a row that plainly has an entry price.
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: 0, entryPrice: 5 }),
        leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG280PE', qty: 0, entryPrice: 4 }),
      ],
      undefined,
    )

    expect(rows[0]?.entry).toBe(4.5)
  })
})

describe('compareLadder', () => {
  /**
   * THE ORDER AS DISPLAYED. `compareLadder` is written ascending because the
   * table plugin owns the direction and negates it for `descending` — which is
   * what the Positions table defaults to — so the tests negate it exactly the
   * same way rather than reading `.reverse()`, which is a different operation
   * on ties.
   */
  const ladder = (rows: readonly PositionRow[]): string[] =>
    [...rows].sort((a, b) => -compareLadder(a, b)).map((r) => r.tradingsymbol)

  test('calls sit above puts, and each side runs high strike to low', () => {
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L1', tradingsymbol: 'DLF26AUG600PE', qty: 4750, entryPrice: 3.45, strike: 600, type: 'PE' }),
        leg({ deskTag: 'L2', tradingsymbol: 'DLF26AUG710CE', qty: 4750, entryPrice: 3.55, strike: 710, type: 'CE' }),
        leg({ deskTag: 'L3', tradingsymbol: 'DLF26AUG650PE', qty: -4750, entryPrice: 16.5, strike: 650, type: 'PE' }),
        leg({ deskTag: 'L4', tradingsymbol: 'DLF26AUG660CE', qty: -4750, entryPrice: 16.6, strike: 660, type: 'CE' }),
        leg({ deskTag: 'L5', tradingsymbol: 'DLF26AUG640PE', qty: -950, entryPrice: 5.1, strike: 640, type: 'PE' }),
      ],
      undefined,
    )

    // The chain, read the way an operator reads one: the upside wing at the top
    // of the screen, the downside wing at the bottom, strike falling between.
    expect(ladder(rows)).toEqual([
      'DLF26AUG710CE', 'DLF26AUG660CE', 'DLF26AUG650PE', 'DLF26AUG640PE', 'DLF26AUG600PE',
    ])
  })

  test('a leg this bridge does not label CE or PE sinks to the bottom, and scrambles nothing above it', () => {
    /*
      `BridgeLeg['type']` says CE or PE, and a RUNNING bridge is not obliged to
      agree — a futures hedge is the obvious case. The cast is the point of the
      test: the ordering must degrade to "last" rather than depend on a union
      holding at runtime. Its strike is the futures 0, which would otherwise
      sort it under the 600 put.
    */
    const odd = {
      ...leg({ deskTag: 'L9', tradingsymbol: 'DLF26AUGFUT', qty: 4750, entryPrice: 665, strike: 0 }),
      type: 'FUT' as unknown as BridgeLeg['type'],
    }
    const rows = consolidatePositions(
      [
        odd,
        leg({ deskTag: 'L1', tradingsymbol: 'DLF26AUG600PE', qty: 4750, entryPrice: 3.45, strike: 600, type: 'PE' }),
        leg({ deskTag: 'L2', tradingsymbol: 'DLF26AUG710CE', qty: 4750, entryPrice: 3.55, strike: 710, type: 'CE' }),
      ],
      undefined,
    )

    expect(ladder(rows)).toEqual(['DLF26AUG710CE', 'DLF26AUG600PE', 'DLF26AUGFUT'])
  })

  test('a leg with no usable strike does not turn the comparator into NaN', () => {
    /*
      A NaN comparison reads as "equal" to `Array.prototype.sort`, which makes
      the comparator INCONSISTENT — and an inconsistent comparator corrupts the
      order of the rows around the bad one, not just its own place. So the
      option ladder either side of it has to survive intact.
    */
    const broken = leg({
      deskTag: 'L8', tradingsymbol: 'DLF26AUG???PE', qty: -950, entryPrice: 1,
      strike: Number.NaN, type: 'PE',
    })
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L1', tradingsymbol: 'DLF26AUG600PE', qty: 4750, entryPrice: 3.45, strike: 600, type: 'PE' }),
        broken,
        leg({ deskTag: 'L3', tradingsymbol: 'DLF26AUG650PE', qty: -4750, entryPrice: 16.5, strike: 650, type: 'PE' }),
      ],
      undefined,
    )

    expect(ladder(rows)).toEqual(['DLF26AUG650PE', 'DLF26AUG600PE', 'DLF26AUG???PE'])
  })

  test('two rows of one contract — a hedged pair — keep book order rather than swapping between polls', () => {
    // Same strike, same type, opposite directions: nothing separates them, and
    // a comparator that broke the tie arbitrarily would reorder the table under
    // the operator on every 5-second poll.
    const rows = consolidatePositions(
      [
        leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
        leg({ deskTag: 'L9', tradingsymbol: 'ITC26AUG277.5PE', qty: 1725, entryPrice: 6.0 }),
      ],
      undefined,
    )

    expect([...rows].sort((a, b) => -compareLadder(a, b)).map((r) => r.qty)).toEqual([-1725, 1725])
  })
})

describe('bookTotals', () => {
  /*
    The desk's own report reads these three off every marked row — MTM, Net TV
    and Δ0 — and the dashboard showed none of them. The formulas here are the
    report's formulas (see sensibull-desk `report_html.py` / `book.py`): MTM is
    qty x (mark − entry), net TV counts a SHORT leg's time value as collected
    (positive) and a long's as paid, and Δ0 is the linear gamma estimate
    spot − netΔ/netΓ.
  */
  const LEGS = [
    leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
    leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
    { ...leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5 }), strike: 280 },
  ]
  const GREEKS = bookGreeks([
    priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.34 }),
    priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.34 }),
    priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 }),
  ])

  test('MTM is qty x (mark − entry), summed over the priced legs', () => {
    const t = bookTotals(LEGS, GREEKS, 279)
    // -1725(4.6-4.7) + -1725(4.6-4.45) + -1725(4.6-5) — a short gains as the mark falls.
    expect(t.mtm).toBeCloseTo(172.5 - 258.75 + 690, 6)
  })

  test('net TV counts short time value as collected, and nets intrinsic off the mark', () => {
    const t = bookTotals(LEGS, GREEKS, 279)
    // 277.5PE at spot 279 is all time value (4.6); 280PE carries 1.0 intrinsic, so 3.6.
    expect(t.netTv).toBeCloseTo(1725 * (4.6 + 4.6 + 3.6), 6)
  })

  test('Δ0 is spot − netΔ/netΓ, with the distance from spot as a percentage', () => {
    const t = bookTotals(LEGS, GREEKS, 279)
    const k = 279 - GREEKS.netDelta / GREEKS.netGamma
    expect(t.neutral?.price).toBeCloseTo(k, 6)
    expect(t.neutral?.pct).toBeCloseTo(((k - 279) / 279) * 100, 6)
  })

  test('a long leg subtracts from net TV — time value paid, not collected', () => {
    const legs = [{ ...leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: 1725, entryPrice: 5 }), strike: 280 }]
    const t = bookTotals(legs, bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: 1725, delta: -0.41 })]), 279)
    expect(t.netTv).toBeCloseTo(-1725 * 3.6, 6)
  })

  test('nothing priced means null, never 0 — a flat figure over no marks is the lie', () => {
    const t = bookTotals(LEGS, bookGreeks([], ['ITC26AUG277.5PE', 'ITC26AUG280PE']), 279)
    expect(t.mtm).toBe(null)
    expect(t.netTv).toBe(null)
    expect(t.neutral).toBe(null)
  })

  test('no spot means no TV and no Δ0 — but MTM needs no spot and stays', () => {
    const t = bookTotals(LEGS, GREEKS, null)
    expect(t.mtm).not.toBe(null)
    expect(t.netTv).toBe(null)
    expect(t.neutral).toBe(null)
  })

  test('zero net gamma renders no Δ0 rather than dividing by it', () => {
    const flat = bookGreeks([{ ...priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 }), gamma: 0, positionGamma: 0 }])
    const t = bookTotals([LEGS[2]!], flat, 279)
    expect(t.neutral).toBe(null)
  })
})

/**
 * WHERE THE BOOK EXPIRES FLAT.
 *
 * Every case here is checked against a figure computed by hand in the comment
 * beside it, because the whole value of this tile is that the operator can trust
 * two numbers they did not compute. It is deliberately NOT a property test: the
 * interesting failures are the boundaries — a side with no crossing, a crossing
 * behind a nearer one, a root that falls outside the segment it came from — and
 * each of those is a named case.
 */
describe('bookBreakevens', () => {
  /** One option leg, either type, any strike. The maths needs nothing else. */
  function opt(over: {
    strike: number; type: 'CE' | 'PE'; qty: number; entryPrice: number
  }): BridgeLeg {
    return {
      deskTag: 'BE',
      instrument: { tradingsymbol: `TCS26AUG${over.strike}${over.type}`, instrumentToken: 1, lotSize: 175 },
      underlying: 'TCS', expiry: '2026-08-27',
      strike: over.strike, type: over.type,
      side: over.qty < 0 ? 'Sell' : 'Buy',
      qty: over.qty, entryPrice: over.entryPrice, openedTs: 1,
    }
  }

  test('a short strangle breaks even at each short strike plus the credit', () => {
    // Credit is 21.35 + 18.05 = 39.40 a share, so the book survives to
    // 2540 + 39.40 on the way up and 2440 − 39.40 on the way down. The LOT SIZE
    // does not enter it: both sides scale by the same 175, which is exactly why
    // a breakeven is a price rather than an amount.
    const be = bookBreakevens([
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
    ], 2487.4)
    expect(be?.up?.price).toBeCloseTo(2579.4, 8)
    expect(be?.down?.price).toBeCloseTo(2400.6, 8)
  })

  test('the distance is a percentage of spot, signed by the side it is on', () => {
    const be = bookBreakevens([
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
    ], 2487.4)
    expect(be?.up?.pct).toBeCloseTo(((2579.4 - 2487.4) / 2487.4) * 100, 8)
    expect(be?.down?.pct).toBeCloseTo(((2400.6 - 2487.4) / 2487.4) * 100, 8)
    // The sign is what the tile tints on, so it is asserted rather than implied.
    expect(be?.up?.pct).toBeGreaterThan(0)
    expect(be?.down?.pct).toBeLessThan(0)
  })

  test('a long wing narrows the upper breakeven by exactly what it cost', () => {
    // Buying the 2600 call for 6.40 spends part of the credit: 39.40 − 6.40 =
    // 33.00, so the upper breakeven comes in from 2579.40 to 2573 and the lower
    // one from 2400.60 to 2407. The wing itself is out of the money at both.
    const be = bookBreakevens([
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
      opt({ strike: 2600, type: 'CE', qty: 175, entryPrice: 6.4 }),
    ], 2487.4)
    expect(be?.up?.price).toBeCloseTo(2573, 8)
    expect(be?.down?.price).toBeCloseTo(2407, 8)
  })

  test('a one-sided book reports one breakeven and NULL for the side that has none', () => {
    // A lone short put is flat at +credit for every price above its strike.
    // There is no level up there at which it returns to zero, and inventing one
    // would be the only genuinely dangerous thing this function could do.
    const be = bookBreakevens([opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 })], 2487.4)
    expect(be?.up).toBe(null)
    expect(be?.down?.price).toBeCloseTo(2418.65, 8)
  })

  test('a long call has an upper breakeven and no lower one', () => {
    // Below the strike it is flat at the premium paid — a loss, and a constant
    // one, so the downside never crosses back through zero either.
    const be = bookBreakevens([opt({ strike: 2540, type: 'CE', qty: 175, entryPrice: 18.05 })], 2487.4)
    expect(be?.up?.price).toBeCloseTo(2558.05, 8)
    expect(be?.down).toBe(null)
  })

  /*
    A RATIO BOOK CROSSES ZERO MORE THAN TWICE, and the tile shows the two that
    bound the price now. The far pair sits behind the near one — the underlying
    cannot reach it without passing through — so reporting all four would bury
    the only two an operator is managing.

    Short 1x 2440 PE at 20 against long 2x 2340 PE at 2:
      credit           175 x 20 − 350 x 2      = 2,800
      above 2440       flat at +2,800           -> no crossing
      2340 … 2440      2800 − 175(2440 − S)     -> zero at 2424
      below 2340       394,800 − 175 S          -> zero at 2256
  */
  const RATIO = [
    opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 20 }),
    opt({ strike: 2340, type: 'PE', qty: 350, entryPrice: 2 }),
  ]

  test('with two crossings below spot, the NEARER one is the lower breakeven', () => {
    const be = bookBreakevens(RATIO, 2450)
    expect(be?.down?.price).toBeCloseTo(2424, 6)
    expect(be?.up).toBe(null)
  })

  test('with both crossings above spot, the NEARER one is the upper breakeven', () => {
    const be = bookBreakevens(RATIO, 2200)
    expect(be?.up?.price).toBeCloseTo(2256, 6)
    expect(be?.down).toBe(null)
  })

  test('a leg closed to nothing is excluded — its premium is already booked', () => {
    const be = bookBreakevens([
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
      opt({ strike: 2300, type: 'PE', qty: 0, entryPrice: 9 }),
    ], 2487.4)
    // Identical to the plain strangle above: a qty-0 row must not move a level.
    expect(be?.up?.price).toBeCloseTo(2579.4, 8)
    expect(be?.down?.price).toBeCloseTo(2400.6, 8)
  })

  /*
    BOOKED P&L SHIFTS THE WHOLE CURVE, so it moves every level by the same
    rupee amount. The strangle above banks +1,750 — 10 a share over 175 — and
    both breakevens step OUT by exactly 10: the run survives ten more points
    each way than its open legs alone would.
  */
  test('realised profit widens both breakevens by exactly what was banked', () => {
    const be = bookBreakevens([
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
    ], 2487.4, 1750)
    expect(be?.up?.price).toBeCloseTo(2589.4, 8)
    expect(be?.down?.price).toBeCloseTo(2390.6, 8)
  })

  /*
    THE 2026-08-21 TCS SHAPE: a book whose OPEN legs lose everywhere at expiry
    — a call spread paid more than its width — but whose RUN is ahead because
    earlier legs banked more than the open ones can lose. Open legs alone have
    no zero to find and the tile dashed both sides, while the payoff panel
    (realised folded in) printed a band. The run-level truth is the level.

    Long 2440 CE at 30 against short 2460 CE at 5, 175 a side: debit 25 against
    a width of 20, so at expiry it holds between −4,375 and −875 — never flat.
    Banking +1,750 lifts that to [−2,625, +875]: one crossing, on the segment
    between the strikes, at 175·(S − 2470) + 875 + 1750 = 0 → S = 2455.
  */
  const PAID_OVER_WIDTH = [
    opt({ strike: 2440, type: 'CE', qty: 175, entryPrice: 30 }),
    opt({ strike: 2460, type: 'CE', qty: -175, entryPrice: 5 }),
  ]

  test('open legs that never cross zero report NOTHING without realised…', () => {
    const be = bookBreakevens(PAID_OVER_WIDTH, 2450)
    expect(be?.up).toBe(null)
    expect(be?.down).toBe(null)
  })

  test('…and the level the booked profit creates once it is folded in', () => {
    const be = bookBreakevens(PAID_OVER_WIDTH, 2450, 1750)
    expect(be?.up?.price).toBeCloseTo(2455, 6)
    expect(be?.down).toBe(null)
  })

  test('a null realised — the bridge could not vouch — changes nothing', () => {
    // Same degrade as `sinceEntryTotal`: unknown is treated as absent, so the
    // tile keeps saying what the open legs alone say rather than dashing out.
    const withNull = bookBreakevens([
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
    ], 2487.4, null)
    expect(withNull?.up?.price).toBeCloseTo(2579.4, 8)
    expect(withNull?.down?.price).toBeCloseTo(2400.6, 8)
  })

  test('an empty book and a missing spot both report nothing at all', () => {
    expect(bookBreakevens([], 2487.4)).toBe(null)
    expect(bookBreakevens([opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 })], null)).toBe(null)
    expect(bookBreakevens([opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 })], 0)).toBe(null)
  })

  test('IT NEEDS NO MARKS, so an unpriced book still has its two levels', () => {
    /*
      This is the property that makes the tile worth having: the greeks, the MTM
      and Δ0 all dash out the moment the feed stops, and these do not. The
      function takes no greeks at all — the assertion is that the levels a fully
      marked book reports are computed from the same three fields an unmarked one
      still carries, so `unpriced` cannot reach them.
    */
    const legs = [
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
    ]
    const be = bookBreakevens(legs, 2487.4)
    expect(be?.up?.price).toBeCloseTo(2579.4, 8)
    // And a book whose totals are all null still answers with both levels.
    const totals = bookTotals(legs, bookGreeks([], legs.map((l) => l.instrument.tradingsymbol)), 2487.4)
    expect(totals.mtm).toBe(null)
    expect(be?.down?.price).toBeCloseTo(2400.6, 8)
  })

  test('spot sitting exactly on a breakeven shows it on both sides, at 0%', () => {
    // Neither side may drop it: "the book is at its breakeven right now" is the
    // one moment the level matters most.
    const be = bookBreakevens([
      opt({ strike: 2440, type: 'PE', qty: -175, entryPrice: 21.35 }),
      opt({ strike: 2540, type: 'CE', qty: -175, entryPrice: 18.05 }),
    ], 2400.6)
    expect(be?.down?.price).toBeCloseTo(2400.6, 8)
    expect(be?.down?.pct).toBeCloseTo(0, 8)
    expect(be?.up?.price).toBeCloseTo(2400.6, 8)
  })
})

describe('the positions table', () => {
  test('renders one row per contract, and SAYS how many legs it merged', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode: 'paper', spot: 279, asOf: Date.now(), complete: true,
            legs: [
              leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
              leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.45 }),
              leg({ deskTag: 'L3', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5 }),
            ],
            greeks: bookGreeks([
              priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.34 }),
              priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.34 }),
              priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 }),
            ]),
          },
        }
      }
      // The diff panel renders alongside the table and reads these lists; an
      // undeclared book is the quiet case and keeps this test about the table.
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )

    /*
      THE CELL RENDERS THE HUMAN NAME, not the exchange packing — `ITC 280 PE`,
      via `formatContract`. This assertion was written against the raw symbol
      and had been failing since that formatting landed; it is asserted the way
      the operator actually reads it now, which is also the only way it can
      catch the column rendering the wrong contract.
    */
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    // ONE row, where there used to be two identical-looking ones.
    expect(screen.getAllByText('ITC 277.5 PE')).toHaveLength(1)
    expect(screen.getByText('-3,450')).toBeTruthy()
    expect(screen.getByText('4.58')).toBeTruthy()

    /*
      P&L PER ROW, off the three columns beside it: -3,450 x (4.60 − 4.575) and
      -1,725 x (4.60 − 5.00). Both are shorts, so the second is the profitable
      one — which is the reading a sign error would invert while leaving every
      other figure on the page correct.
    */
    expect(screen.getByText('-86')).toBeTruthy()
    expect(screen.getByText('+690')).toBeTruthy()

    /*
      THE MERGE IS SILENT NOW — user-directed 2026-08-17 ("we dont want to see
      3 legs blue chip and just show single entry avg price"): no tranche badge,
      no per-tranche price line, only the size-weighted average the row already
      shows. The tranche story lives in the Open legs card and the order log.
    */
    expect(screen.queryByText('2 legs')).toBe(null)
    expect(screen.queryByText('4.70 · 4.45')).toBe(null)

    // The header carries both counts, because the desk still works in legs.
    expect(screen.getByText(/2 contracts · 3 legs/)).toBeTruthy()

    // The report's three figures, now on the cards: MTM, net TV, and the
    // delta-neutral spot with its distance from here.
    //
    // `getAllByText`: the table's own TOTAL row carries the same figure, and on
    // a two-contract book the total of one number IS that number. Both places
    // showing it is the point — the tile states it, the footer lets it be
    // checked against the column that produced it.
    expect(screen.getAllByText('+604').length).toBeGreaterThan(0)
    // All three mocked legs sit at the helper's 277.5 strike, out of the money
    // at spot 279, so every mark is pure time value: 1725 x (4.6 x 3).
    expect(screen.getByText('+23,805')).toBeTruthy()
    expect(screen.getByText('297.2 (+6.5%)')).toBeTruthy()
  })

  test('opens in the ladder — calls above puts, strike falling — and the Contract header flips it', async () => {
    /*
      THE SAME BOOK THE OPERATOR WAS LOOKING AT WHEN THEY ASKED FOR THIS: five
      DLF legs stored in the order the desk happened to open them, which is the
      order the table used to render. `getAllByText` returns matches in DOCUMENT
      order, so this asserts what is actually on the screen top to bottom rather
      than what the comparator returns.
    */
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: 'DLF-2026-08-25-recenter-relief-r', symbol: 'DLF', mode: 'paper',
            spot: 663.15, asOf: Date.now(), complete: true,
            legs: [
              leg({ deskTag: 'L1', tradingsymbol: 'DLF26AUG600PE', qty: 4750, entryPrice: 3.45, strike: 600, type: 'PE' }),
              leg({ deskTag: 'L2', tradingsymbol: 'DLF26AUG710CE', qty: 4750, entryPrice: 3.55, strike: 710, type: 'CE' }),
              leg({ deskTag: 'L3', tradingsymbol: 'DLF26AUG650PE', qty: -4750, entryPrice: 16.5, strike: 650, type: 'PE' }),
              leg({ deskTag: 'L4', tradingsymbol: 'DLF26AUG660CE', qty: -4750, entryPrice: 16.6, strike: 660, type: 'CE' }),
              leg({ deskTag: 'L5', tradingsymbol: 'DLF26AUG640PE', qty: -950, entryPrice: 5.1, strike: 640, type: 'PE' }),
            ],
            greeks: bookGreeks([
              priced({ tradingsymbol: 'DLF26AUG600PE', qty: 4750, delta: -0.061 }),
              priced({ tradingsymbol: 'DLF26AUG710CE', qty: 4750, delta: 0.14 }),
              priced({ tradingsymbol: 'DLF26AUG650PE', qty: -4750, delta: -0.333 }),
              priced({ tradingsymbol: 'DLF26AUG660CE', qty: -4750, delta: 0.558 }),
              priced({ tradingsymbol: 'DLF26AUG640PE', qty: -950, delta: -0.242 }),
            ]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag="DLF-2026-08-25-recenter-relief-r" />
        </ModeProvider>
      </AuthProvider>,
    )

    const contracts = (): (string | null)[] =>
      screen.getAllByText(/^DLF \d+ (CE|PE)$/).map((el) => el.textContent)

    await waitFor(() => expect(contracts()).toHaveLength(5))
    expect(contracts()).toEqual([
      'DLF 710 CE', 'DLF 660 CE', 'DLF 650 PE', 'DLF 640 PE', 'DLF 600 PE',
    ])

    // The header is a button — the plugin's own affordance — and its accessible
    // name states the direction, which is the half of this a screen reader gets.
    const header = screen.getByRole('button', { name: /Sort by Contract/ })
    act(() => { header.click() })

    // Flipped, not cleared: there is no unsorted third state to land on.
    expect(contracts()).toEqual([
      'DLF 600 PE', 'DLF 640 PE', 'DLF 650 PE', 'DLF 660 CE', 'DLF 710 CE',
    ])
  })
})

/**
 * STALE MARKS MEAN TWO DIFFERENT THINGS, and the banner used to say only one.
 *
 * `stale` is set whenever a mark came off the persisted snapshot rather than a
 * live tick. Outside a session that is simply how a shut market looks. DURING a
 * session it is a feed outage — and the banner called that "Market closed",
 * which is a weekday feed failure explained away as normal.
 */
describe('the stale-marks banner', () => {
  /** Tue 2026-07-28, 11:00 IST. */
  const SESSION = new Date('2026-07-28T11:00:00+05:30').getTime()
  /** Sat 2026-08-01, 11:00 IST. */
  const WEEKEND = new Date('2026-08-01T11:00:00+05:30').getTime()

  // Fake timers, so the session rule is asked about a known moment. `waitFor`
  // polls the timers they replace, so the clock is advanced from out here and
  // the assertions use `getByText` — the pattern `books.test.tsx` documents.
  afterEach(() => { vi.useRealTimers() })

  async function mountAt(now: number, marksAsOf: number): Promise<void> {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode: 'paper', spot: 279, asOf: now, complete: true,
            stale: true, marksAsOf,
            legs: [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5 })],
            greeks: bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 })]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }

  test('outside a session, stale marks are just a shut market', async () => {
    await mountAt(WEEKEND, WEEKEND - 3 * 24 * 3600_000)
    expect(screen.getByText('Market closed — showing last known marks')).toBeTruthy()
  })

  test('DURING a session, the same staleness is a feed outage — and says so', async () => {
    // The defect: a Tuesday-morning feed failure labelled "Market closed",
    // which is the one reading that tells the operator to do nothing.
    await mountAt(SESSION, SESSION - 40 * 60_000)
    expect(screen.queryByText('Market closed — showing last known marks')).toBe(null)
    expect(screen.getByText(/marks are stale/i)).toBeTruthy()
  })
})

/**
 * TWO NUMBERS CALLED P&L, ANSWERING DIFFERENT QUESTIONS.
 *
 * The MTM tile is the DAY: realised plus open, off the journal, the same figure
 * the strategy's P&L chip carries. The table's Total is the OPEN book only,
 * marked against the desk's own entries — mark-vs-entry over the rows above it.
 * They legitimately differ (see `pnl` in positions.ts) and on screen both used
 * to say only "P&L"/"MTM", which is the same operator-confusion class as the
 * tile-vs-chip disagreement of 2026-08-04 (audit F-52). Neither number moves;
 * each says which question it answers.
 *
 * THE AGES ARE THE OTHER HALF. `usePoll` keeps the last payload when a read
 * fails — stale-but-labelled — and until now nothing printed the label.
 */
describe('what the figures are OF, and how old they are', () => {
  function mountBook(): void {
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode: 'paper', spot: 279, asOf: Date.now(), complete: true,
            legs: [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5 })],
            greeks: bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 })]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/margin') {
        return { body: { available: true, brokerTotal: 900_000, brokerSpan: 800_000, brokerExposure: 100_000, ageMs: 20_000 } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )
  }

  test('the P&L tile and the table Total are ONE anchor — since entry, said on both', async () => {
    // Operator's call 2026-08-18: the tile used to show the DAY while the
    // table foot showed the book since entry, and the pair read as a
    // discrepancy every session. Now both say since-entry.
    mountBook()
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    expect(screen.getByText('since entry')).toBeTruthy()
    expect(screen.getByText('open, since entry')).toBeTruthy()
    expect(screen.queryByText('day')).toBe(null)
  })

  test('the header says how old the reading it is showing is', async () => {
    mountBook()
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    // The promise `usePoll` has always made — "these are the last known
    // values" — finally rendered rather than merely commented.
    expect(screen.getAllByText(/^as of /).length).toBeGreaterThan(0)
  })

  test('a fresh margin figure carries the age of the READ that fetched it', async () => {
    mountBook()
    await waitFor(() => expect(screen.getByText('9L')).toBeTruthy())
    const label = screen.getByText('Margin (book)')
    const row = label.parentElement as HTMLElement
    expect(within(row).getByText(/^as of /)).toBeTruthy()
  })
})

/**
 * THE +95k THAT WAS A LOSS (2026-08-18). The table's rows are the OPEN book,
 * so their sum is what the surviving legs show since entry — and on the day
 * the live BHEL book closed a leg realising −95,524, that sum read +95,419
 * while the book's true lifetime P&L was ≈ −105. The F-52 sub-label made the
 * figure honest without making it the answer; `summaryRows` is the answer:
 * the open subtotal, the booked figure, and their sum, each saying what it is.
 */
describe('summaryRows', () => {
  const row = (over: Partial<PositionRow>): PositionRow => ({
    tradingsymbol: 'ITC26AUG280PE', strike: 280, type: 'PE', qty: -1725,
    entry: 5, entries: [5], fills: 1, mark: 4.6, iv: 0.22, delta: -0.41,
    lotSize: 1725,
    posDelta: 707.25, pnl: 690, quote: null, unpriced: false, modelPriced: false, ...over,
  })

  test('with a realised figure the block is Open, Realised, and their sum', () => {
    const out = summaryRows([row({})], -95_524)

    expect(out.map((r) => r.summary?.label)).toEqual(['Open', 'Realised', 'Total'])
    expect(out[0]?.pnl).toBe(690)
    expect(out[1]?.pnl).toBe(-95_524)
    // Total = Open + Realised BY CONSTRUCTION — the property that keeps the
    // block checkable by eye against the column above it.
    expect(out[2]?.pnl).toBe(690 - 95_524)
    // One answer, two components: only the net Total is the strong row.
    expect(out.map((r) => r.summary?.strong === true)).toEqual([false, false, true])
    // Every summary row is a sentinel, so every cell that dashes still does.
    expect(out.every((r) => r.isTotal === true)).toBe(true)
  })

  test('with NO realised figure the block is exactly the old single Total row', () => {
    // An older bridge, or one that could not vouch for the number — the page
    // must render precisely what it always did, label included.
    const out = summaryRows([row({})], null)

    expect(out).toHaveLength(1)
    expect(out[0]?.summary).toEqual({ label: 'Total', note: 'open, since entry', strong: true })
    expect(out[0]?.pnl).toBe(690)
    expect(out[0]?.posDelta).toBe(707.25)
  })

  test('an unpriced row makes Open — and therefore the net — unknown; Realised keeps its number', () => {
    // Null, never 0, on the open side: the sum over the rows that DID price is
    // understated by an unknown amount. Realised is BOOKED — no mark can
    // change it — so it alone stays a number.
    const out = summaryRows([row({}), row({ tradingsymbol: 'ITC26AUG277.5PE', pnl: null })], -95_524)

    expect(out[0]?.pnl).toBe(null)
    expect(out[1]?.pnl).toBe(-95_524)
    expect(out[2]?.pnl).toBe(null)
  })

  test('no rows, no block — a loading book gets no summary of nothing', () => {
    expect(summaryRows([], -95_524)).toEqual([])
  })

  test('the delta total rides the STRONG row only, over the rows the view names', () => {
    const short = row({})
    const long = row({ tradingsymbol: 'ITC26AUG290CE', qty: 1725, posDelta: 241.5 })
    // The shorts-only view hands in the short rows; the P&L block is untouched
    // by the choice — realised legs have no delta and money has no view.
    const out = summaryRows([short, long], -95_524, [short])

    expect(out[0]?.posDelta).toBe(null)
    expect(out[1]?.posDelta).toBe(null)
    expect(out[2]?.posDelta).toBe(707.25)
    expect(out[2]?.pnl).toBe(690 + 690 - 95_524)
  })
})

/**
 * THE GREEKS THE WAY THE RULES SEE THEM. Under `delta_shorts_only` the
 * strategy steers on its SHORT legs only — on BHEL 2026-08-14 the book
 * carried +408 delta while the shorts alone were −1836, opposite signs,
 * the long hedges holding the difference. `shortsOnlyGreeks` is the engine's
 * own per-leg figures re-summed over that set, so the shorts-only tiles and
 * the shorts-only Pos delta total still reconcile by eye.
 */
describe('shortsOnlyGreeks', () => {
  const legs = [
    leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
    leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG290CE', qty: 1725, entryPrice: 2.1, strike: 290, type: 'CE' }),
  ]

  test('keeps only the short legs, and the nets are THEIR sums', () => {
    const g = bookGreeks([
      priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.4 }),
      priced({ tradingsymbol: 'ITC26AUG290CE', qty: 1725, delta: 0.2 }),
    ])
    const s = shortsOnlyGreeks(g, legs)

    expect(s?.legs.map((l) => l.tradingsymbol)).toEqual(['ITC26AUG277.5PE'])
    // -0.4 x -1725: the shorts' own delta, not the book's 690 + 345.
    expect(s?.netDelta).toBeCloseTo(690, 6)
    expect(g.netDelta).toBeCloseTo(1035, 6)
  })

  test('an unpriced LONG hedge does not qualify a total it is not in', () => {
    const g = bookGreeks(
      [priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.4 })],
      ['ITC26AUG290CE'],
    )
    const s = shortsOnlyGreeks(g, legs)
    expect(s?.unpriced).toEqual([])
  })

  test('no greeks in, no greeks out — undefined stays "not loaded", never {}', () => {
    expect(shortsOnlyGreeks(undefined, legs)).toBe(undefined)
  })
})

describe('the summary block on screen', () => {
  function mountWithRealised(realised: number | null): void {
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode: 'paper', spot: 279, asOf: Date.now(), complete: true,
            realised,
            legs: [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5 })],
            greeks: bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 })]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )
  }

  test('Open, Realised and the NET Total, each saying what it is', async () => {
    mountWithRealised(-95_524)
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())

    // The three names and their three sub-labels.
    expect(screen.getByText('Open')).toBeTruthy()
    expect(screen.getByText('open legs, since entry')).toBeTruthy()
    expect(screen.getByText('Realised')).toBeTruthy()
    expect(screen.getByText('booked on closed legs')).toBeTruthy()
    expect(screen.getByText('net, open + realised')).toBeTruthy()

    // The BHEL shape: the open leg is up +690 since entry, the book is not.
    expect(screen.getByText('-95,524')).toBeTruthy()
    // TWICE, by design: the P&L tile and the Total row are one number now —
    // `sinceEntryTotal` feeds both, so both render −94,834.
    expect(screen.getAllByText('-94,834')).toHaveLength(2)
  })

  test('a payload with realised NULL renders the one Total row it always had', async () => {
    mountWithRealised(null)
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())

    expect(screen.getByText('Total')).toBeTruthy()
    expect(screen.getByText('open, since entry')).toBeTruthy()
    expect(screen.queryByText('Realised')).toBe(null)
    expect(screen.queryByText('net, open + realised')).toBe(null)
  })
})

/**
 * THE SHORTS-ONLY TOGGLE. What it swaps is pinned as much as what it must
 * never touch: the greek tiles, Δ0, net TV and the Pos delta total follow the
 * short set; the rows, the P&L block and the MTM tile stay the whole book.
 */
describe('the shorts-only view', () => {
  function mountBook(steering: { delta: number; gamma: number } | null): void {
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode: 'paper', spot: 279, asOf: Date.now(), complete: true,
            steering,
            legs: [
              leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, entryPrice: 4.7 }),
              leg({ deskTag: 'L2', tradingsymbol: 'ITC26AUG290CE', qty: 1725, entryPrice: 2.1, strike: 290, type: 'CE' }),
            ],
            greeks: bookGreeks([
              priced({ tradingsymbol: 'ITC26AUG277.5PE', qty: -1725, delta: -0.4 }),
              priced({ tradingsymbol: 'ITC26AUG290CE', qty: 1725, delta: 0.2 }),
            ]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )
  }

  const toggle = (): void => {
    act(() => { (screen.getByRole('switch', { name: 'Shorts only' }) as HTMLElement).click() })
  }

  test('the tiles re-total over the short legs, and the labels say so', async () => {
    mountBook(null)
    await waitFor(() => expect(screen.getByText('ITC 277.5 PE')).toBeTruthy())
    // Whole book first: -0.4 x -1725 + 0.2 x 1725. `getAllByText`, as the
    // established pattern above: the tile and the column's own total BOTH
    // show the figure, and both showing it is the point.
    expect(screen.getAllByText('+1,035').length).toBeGreaterThan(0)

    toggle()

    // The shorts alone — and the note naming the smaller set.
    expect(screen.getAllByText('+690').length).toBeGreaterThan(0)
    expect(screen.queryByText('+1,035')).toBe(null)
    expect(screen.getAllByText('shorts only').length).toBeGreaterThan(0)
    // The column head says which rows its total now sums.
    expect(screen.getByText('Pos delta (shorts)')).toBeTruthy()
  })

  test('a declared steering pair IS the figure — the exact numbers the rules acted on', async () => {
    mountBook({ delta: -1836, gamma: -314.9 })
    await waitFor(() => expect(screen.getByText('ITC 277.5 PE')).toBeTruthy())

    toggle()

    expect(screen.getByText('-1,836')).toBeTruthy()
    // Named as the strategy's own, not the engine's smaller sum.
    expect(screen.getAllByText('shorts only · steering').length).toBeGreaterThan(0)
  })

  test('money never follows the view: the P&L total is the whole book either way', async () => {
    mountBook(null)
    await waitFor(() => expect(screen.getByText('ITC 277.5 PE')).toBeTruthy())
    // Short: -1725 x (4.60 - 4.70) = +172.50. Long: 1725 x (4.60 - 2.10) =
    // +4,312.50. Both at the helper's one 4.60 mark, on the Total row and the
    // MTM tile's browser fallback alike — hence `getAllByText`.
    const before = screen.getAllByText('+4,485').length
    expect(before).toBeGreaterThan(0)

    toggle()

    expect(screen.getAllByText('+4,485').length).toBe(before)
  })
})

/**
 * PROTECT — the lots the engine may not spend, from the row that holds them
 * (spec §4, D12).
 *
 * The badge is a claim about what an unattended engine will and will not do
 * with a real position, so what is pinned here is that the number on the row is
 * the SERVER's (not a local optimism), that the write says which instrument and
 * how many LOTS, and that the live rail asks for the password first.
 */
describe('the Protect control on a leg row', () => {
  function mountBook(
    protectedQty: Record<string, number>,
    mode: 'paper' | 'live' = 'paper',
  ): SentRequest[] {
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode, spot: 279, asOf: Date.now(), complete: true,
            legs: [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: -5175, entryPrice: 5, strike: 280 })],
            greeks: bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: -5175, delta: -0.41 })]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/engine/protect') {
        return { body: { tag: TAG, mode, protectedQty } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode={mode} tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )
    return sent
  }

  test('a book nobody has protected shows no claim, and offers one', async () => {
    mountBook({})
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Protect' })).toBeTruthy()
  })

  test('a pinned instrument reads its lots on the row', async () => {
    mountBook({ ITC26AUG280PE: 2 })
    await waitFor(() => expect(screen.getByText('2 lots')).toBeTruthy())
    // ...and the button says what pressing it does now.
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy()
  })

  test('the dialog states the held size in LOTS, and the write names them', async () => {
    const sent = mountBook({})
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    act(() => { screen.getByRole('button', { name: 'Protect' }).click() })

    // 5,175 contracts of 1,725 = 3 lots. The table speaks contracts and the
    // engine speaks lots; the dialog is where the two are reconciled.
    await screen.findByText(/holds 3 lot\(s\) — 5175 contracts of 1725/)

    fireEvent.change(screen.getByLabelText('Lots the engine may not spend'), { target: { value: '2' } })
    act(() => { screen.getByRole('button', { name: 'Protect 2 lot(s)' }).click() })

    await waitFor(() => {
      const post = sent.find((r) => r.path === '/v1/desk/engine/protect' && r.method === 'POST')
      expect(post?.body).toEqual({
        tag: TAG, mode: 'paper', instrument: 'ITC26AUG280PE', protectedQty: 2,
      })
    })
  })

  test('a LIVE book asks for the password BEFORE it pins anything', async () => {
    const sent = mountBook({}, 'live')
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    act(() => { screen.getByRole('button', { name: 'Protect' }).click() })
    await screen.findByLabelText('Lots the engine may not spend')
    act(() => { screen.getByRole('button', { name: /Release this leg|Protect \d+ lot/ }).click() })

    await screen.findByText(/on the LIVE book/)
    expect(sent.filter((r) => r.path === '/v1/desk/engine/protect' && r.method === 'POST')).toEqual([])
  })

  /**
   * A DECORATION MUST NOT COST THE PAGE. A bridge a deploy behind has no such
   * endpoint, and a table of positions that refused to render over a missing
   * badge would trade one small absence for a total one.
   */
  /**
   * A CLAIM IS ABOUT THE BOOK YOU ARE LOOKING AT. The page is not remounted
   * between tabs and the map is polled at 30s beside a 5s position read, so a
   * map answered FOR ANOTHER BOOK must not paint badges on this one — two books
   * on one symbol and expiry is a thing this desk does.
   */
  test('a map answered for a different book paints nothing here', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode: 'paper', spot: 279, asOf: Date.now(), complete: true,
            legs: [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5, strike: 280 })],
            greeks: bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 })]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/engine/protect') {
        // The OTHER book on the same expiry, holding the same strike.
        return { body: { tag: 'ITC-2026-08-27-relief', mode: 'paper', protectedQty: { ITC26AUG280PE: 4 } } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    expect(screen.queryByText('4 lots')).toBe(null)
    expect(screen.getByRole('button', { name: 'Protect' })).toBeTruthy()
  })

  test('a bridge that cannot answer leaves the table intact', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/positions') {
        return {
          body: {
            tag: TAG, symbol: 'ITC', mode: 'paper', spot: 279, asOf: Date.now(), complete: true,
            legs: [leg({ deskTag: 'L1', tradingsymbol: 'ITC26AUG280PE', qty: -1725, entryPrice: 5, strike: 280 })],
            greeks: bookGreeks([priced({ tradingsymbol: 'ITC26AUG280PE', qty: -1725, delta: -0.41 })]),
          },
        }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/engine/protect') return { status: 404, body: { error: 'no such route' } }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <PositionsPage mode="paper" tag={TAG} />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('ITC 280 PE')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Protect' })).toBeTruthy()
  })
})
