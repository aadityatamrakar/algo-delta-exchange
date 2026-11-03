import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BandStatus } from '../src/analytics/band.ts'
import { RATES_NOT_CONFIRMED, SHARES_NOT_IN_PNL, adminPortfolioOf, portfolioOf, type PortfolioInput } from '../src/analytics/portfolio.ts'
import type { MarginView, MtmBlock } from '../src/analytics/wire.ts'
import type { BandState, BookView, Instrument, LegView, SeriesPnl } from '../src/types.ts'
import { NIFTY_W2, NOV, OCT } from './fixtures/r3-market.ts'

const NOW = Date.parse('2026-10-19T11:00:00+05:30')

type Greeks = { delta: number; gamma: number; vega: number; theta: number; mtm: number | null }

function leg(instrument: Instrument, expiry: string, g: Greeks): LegView {
  return {
    key: `manual:${instrument}-${expiry}-${g.delta}`, source: 'manual', clientCode: '', note: '', lotSize: null,
    instrument, expiry, strike: instrument === 'option' ? 3400 : null, optType: instrument === 'option' ? 'CE' : null,
    qty: 175, avgPrice: 50, ltp: 60, iv: instrument === 'option' ? 0.25 : null, ...g, matched: true,
  }
}

function viewOf(stock: string, spot: number | null, legs: LegView[], warnings: string[] = []): BookView {
  const sum = (f: (l: LegView) => number): number => legs.reduce((s, l) => s + f(l), 0)
  return {
    stock, asOf: NOW, closed: false, spot, futures: {}, forwards: {}, legs,
    totals: { delta: sum((l) => l.delta), gamma: sum((l) => l.gamma), vega: sum((l) => l.vega), theta: sum((l) => l.theta), mtm: sum((l) => l.mtm ?? 0) },
    payoff: null, unmatched: [], mismatch: null, historyFrom: null, warnings,
  }
}

function mtmOf(previous: number, today: number, ratesConfirmed = true): MtmBlock {
  const cols = { previous, today, total: previous + today }
  return {
    gross: cols, expense: { previous: null, today: 0, total: 0 }, current: cols,
    squareOff: 0, projected: cols.total, payInOut: 0, cfBalance: 0, openCycleCharges: 0, dayReason: null, partial: [], ratesConfirmed, notes: [],
  }
}

/** The block before the open, or on a closed day: every day column null, with the reason (G5). */
function noDay(dayReason: string): MtmBlock {
  const none = { previous: null, today: null, total: null }
  return { ...mtmOf(0, 0), gross: none, expense: none, current: none, projected: null, dayReason }
}

function marginOf(total: number | null, label: string | null): MarginView {
  return {
    available: total !== null, initial: total, exposure: null, total, peak: null, parts: null,
    span: label === null ? null : { file: 'nsccl.20261019.i3.spn', label, businessDate: '2026-10-19', savedAt: NOW },
    exposureFile: null, stale: false, missing: [], notes: [],
  }
}

function bandOf(state: BandState, sentence: string): BandStatus {
  return {
    state, netDelta: null, bandShares: null, bandLots: null, outByLots: state === 'out' ? 1 : 0, lotSize: null,
    source: 'engine', toNeutralize: null, marketOpen: true, sentence,
  }
}

/** TCS: an OCT leg (delta 500, gamma −2) and a NOV leg (delta −150, gamma 1) — delta 350, vega 1200, theta −3000. */
function tcs(o: Partial<PortfolioInput> = {}): PortfolioInput {
  return {
    view: viewOf('TCS', 4000, [
      leg('option', OCT, { delta: 500, gamma: -2, vega: 700, theta: -2000, mtm: 9000 }),
      leg('option', NOV, { delta: -150, gamma: 1, vega: 500, theta: -1000, mtm: 12000 }),
    ]),
    lotSize: 175, mtm: mtmOf(21000, 4000), margin: marginOf(600000, 'NSE SPAN 13:30'), band: bandOf('out', 'Out of band by 1 lot'),
    ...o,
  }
}

/** NIFTY at 25,000: delta −150, vega 800, theta −1500; no SPAN margin; in band. */
function nifty(o: Partial<PortfolioInput> = {}): PortfolioInput {
  return {
    view: viewOf('NIFTY', 25000, [leg('option', NIFTY_W2, { delta: -150, gamma: -0.5, vega: 800, theta: -1500, mtm: -9000 })]),
    lotSize: 75, mtm: mtmOf(-7500, -2500), margin: marginOf(null, null), band: bandOf('in', 'In band (±3 lots)'),
    ...o,
  }
}

test('rows carry lots from each underlying\'s own lot', () => {
  const p = portfolioOf('ravi', [tcs(), nifty()], NOW)
  assert.deepEqual([p.trader, p.asOf], ['ravi', NOW])
  assert.deepEqual(p.rows.map((r) => [r.stock, r.lotSize, r.delta, r.deltaLots]), [['NIFTY', 75, -150, -2], ['TCS', 175, 350, 2]])
  const [n, t] = p.rows
  // Day MTM is the block's total (21,000 + 4,000); Open P&L the legs at net price (9,000 + 12,000): two figures, two names
  assert.deepEqual([t?.spot, t?.gamma, t?.vega, t?.theta, t?.mtmDay, t?.mtmDayReason, t?.openPnl], [4000, -1, 1200, -3000, 25000, null, 21000])
  assert.deepEqual([t?.margin, t?.marginLabel, t?.band, t?.bandSentence], [600000, 'NSE SPAN 13:30', 'out', 'Out of band by 1 lot'])
  assert.deepEqual([n?.spot, n?.mtmDay, n?.openPnl, n?.margin, n?.marginLabel, n?.band, n?.bandSentence], [25000, -10000, -9000, null, null, 'in', 'In band (±3 lots)'])
  assert.deepEqual(p.warnings, [])
})

test('totals', () => {
  const p = portfolioOf('ravi', [tcs(), nifty()], NOW)
  assert.deepEqual(p.totals, {
    books: 2, outOfBand: 1, deltaValue: -2350000, vega: 2000, theta: -4500, mtmDay: 15000, openPnl: 12000, pnl: null, pnlReason: 'no live expiry', margin: 600000, marginMissing: ['NIFTY'],
  })
})

test('month-wise', () => {
  const t = portfolioOf('ravi', [tcs()], NOW).rows[0]
  assert.deepEqual(t?.months, [
    { expiry: OCT, delta: 500, gamma: -2, vega: 700, theta: -2000, mtm: 9000, pnl: null },
    { expiry: NOV, delta: -150, gamma: 1, vega: 500, theta: -1000, mtm: 12000, pnl: null },
  ])
})

test('month-wise: legs of one expiry add up, ascending, shares last; a leg with no MTM adds none', () => {
  const view = viewOf('TCS', 4000, [
    leg('share', '', { delta: 175, gamma: 0, vega: 0, theta: 0, mtm: 1750 }),
    leg('option', NOV, { delta: -150, gamma: 1, vega: 500, theta: -1000, mtm: null }),
    leg('future', OCT, { delta: 175, gamma: 0, vega: 0, theta: 0, mtm: 875 }),
    leg('option', OCT, { delta: 500, gamma: -2, vega: 700, theta: -2000, mtm: 9000 }),
  ])
  assert.deepEqual(portfolioOf('ravi', [tcs({ view })], NOW).rows[0]?.months, [
    { expiry: OCT, delta: 675, gamma: -2, vega: 700, theta: -2000, mtm: 9875, pnl: null },
    { expiry: NOV, delta: -150, gamma: 1, vega: 500, theta: -1000, mtm: 0, pnl: null },
    { expiry: '', delta: 175, gamma: 0, vega: 0, theta: 0, mtm: 1750, pnl: null },
  ])
})

test('no MTM block: Day MTM is null, never the legs\' Open P&L; the totals\' Day MTM is null too', () => {
  const p = portfolioOf('ravi', [tcs({ mtm: null }), nifty()], NOW)
  const t = p.rows[1]
  assert.deepEqual([t?.stock, t?.mtmDay, t?.mtmDayReason, t?.openPnl], ['TCS', null, null, 21000])
  assert.deepEqual([p.rows[0]?.mtmDay, p.rows[0]?.openPnl], [-10000, -9000], 'with a block, Day MTM is its total')
  assert.deepEqual([p.totals.mtmDay, p.totals.openPnl], [null, 12000])
  assert.deepEqual(p.warnings, ['TCS: Today is not shown — no MTM block'])
})

test("yesterday's close unknown: Day MTM is null, and the legs' Open P&L stays its own figure", () => {
  const base = mtmOf(0, 4000)
  const mtm: MtmBlock = { ...base, current: { previous: null, today: 4000, total: null } }
  const p = portfolioOf('ravi', [tcs({ mtm })], NOW)
  assert.deepEqual([p.rows[0]?.mtmDay, p.rows[0]?.mtmDayReason, p.rows[0]?.openPnl], [null, null, 21000])
  assert.deepEqual(p.warnings, ["TCS: Today is not shown — yesterday's close is unknown"])
})

test('before the open, or on a closed day: Day MTM is null with its reason, said once; Open P&L is untouched (G5)', () => {
  for (const reason of ['market opens 09:15', 'market closed today']) {
    const p = portfolioOf('ravi', [tcs({ mtm: noDay(reason) }), nifty({ mtm: noDay(reason) })], NOW)
    assert.deepEqual(p.rows.map((r) => [r.stock, r.mtmDay, r.mtmDayReason, r.openPnl]), [['NIFTY', null, reason, -9000], ['TCS', null, reason, 21000]])
    assert.deepEqual([p.totals.mtmDay, p.totals.openPnl], [null, 12000])
    assert.deepEqual(p.warnings, [`Today is not shown — ${reason}`])
  }
})

test('charges rates not confirmed: one warning', () => {
  const p = portfolioOf('ravi', [tcs({ mtm: mtmOf(21000, 4000, false) }), nifty({ mtm: mtmOf(-7500, -2500, false) })], NOW)
  assert.deepEqual(p.warnings, [RATES_NOT_CONFIRMED])
  assert.match(RATES_NOT_CONFIRMED, /charges rates not confirmed/)
})

test('an MTM that leaves contracts out says how many', () => {
  const mtm: MtmBlock = { ...mtmOf(21000, 4000), partial: ['a', 'b'] }
  assert.deepEqual(portfolioOf('ravi', [tcs({ mtm })], NOW).warnings, ['TCS: Today leaves out 2 contracts it cannot price'])
})

test('a row without a spot is left out of the delta value, with a warning', () => {
  const view = { ...nifty().view, spot: null }
  const p = portfolioOf('ravi', [tcs(), nifty({ view })], NOW)
  assert.equal(p.totals.deltaValue, 1400000)
  assert.deepEqual(p.warnings, ['NIFTY: no spot price — left out of the delta value'])
})

test('margin: unavailable, or available with no total, is missing; an unknown lot gives no lots', () => {
  const noTotal: MarginView = { ...marginOf(600000, 'NSE SPAN 13:30'), total: null }
  const p = portfolioOf('ravi', [tcs({ margin: noTotal, lotSize: null }), nifty({ margin: null, band: null })], NOW)
  assert.deepEqual(p.rows.map((r) => [r.stock, r.margin, r.marginLabel, r.deltaLots, r.band, r.bandSentence]), [
    ['NIFTY', null, null, -2, null, null], ['TCS', null, 'NSE SPAN 13:30', null, 'out', 'Out of band by 1 lot'],
  ])
  assert.deepEqual([p.totals.margin, p.totals.marginMissing, p.totals.outOfBand], [0, ['NIFTY', 'TCS'], 1])
})

test("each book's own warnings once, naming the books that carry them", () => {
  const dead = 'the price feed is not ticking: every price below is the last one seen, not a live one'
  const p = portfolioOf('ravi', [
    tcs({ view: { ...tcs().view, warnings: [dead, 'TCS spot price is stale — last tick 10:02'] } }),
    nifty({ view: { ...nifty().view, warnings: [dead] } }),
  ], NOW)
  assert.deepEqual(p.warnings, [`NIFTY, TCS: ${dead}`, 'TCS: TCS spot price is stale — last tick 10:02'])
})

test('no books', () => {
  const p = portfolioOf('ravi', [], NOW)
  assert.deepEqual([p.rows, p.warnings], [[], []])
  assert.deepEqual(p.totals, { books: 0, outOfBand: 0, deltaValue: 0, vega: 0, theta: 0, mtmDay: 0, openPnl: 0, pnl: null, pnlReason: null, margin: 0, marginMissing: [] })
})

/** sita: short a lot of TCS (delta −175), vega −300, theta 700; MTM today 500, total 2,000; margin 2,00,000. */
function sitaTcs(): PortfolioInput {
  return {
    view: viewOf('TCS', 4000, [leg('option', OCT, { delta: -175, gamma: 0.5, vega: -300, theta: 700, mtm: 1500 })]),
    lotSize: 175, mtm: mtmOf(1500, 500), margin: marginOf(200000, 'NSE SPAN 13:30'), band: bandOf('in', 'In band (±2 lots)'),
  }
}

test('admin: per stock across traders', () => {
  const ravi = portfolioOf('ravi', [tcs(), nifty()], NOW)
  const sita = portfolioOf('sita', [sitaTcs()], NOW)
  const a = adminPortfolioOf([sita, ravi], NOW)
  assert.equal(a.asOf, NOW)
  assert.deepEqual(a.stocks, [
    { stock: 'NIFTY', traders: 1, delta: -150, deltaLots: -2, gamma: -0.5, vega: 800, theta: -1500, mtmDay: -10000, openPnl: -9000, pnl: null, pnlReason: 'no live expiry', margin: 0 },
    { stock: 'TCS', traders: 2, delta: 175, deltaLots: 1, gamma: -0.5, vega: 900, theta: -2300, mtmDay: 27000, openPnl: 22500, pnl: null, pnlReason: 'no live expiry', margin: 800000 },
  ])
  assert.deepEqual(a.warnings, ['NIFTY: margin leaves out ravi (not available)'])
})

test('admin: one row per trader', () => {
  const ravi = portfolioOf('ravi', [tcs(), nifty()], NOW)
  const sita = portfolioOf('sita', [sitaTcs()], NOW)
  const none = portfolioOf('gita', [], NOW)
  const a = adminPortfolioOf([sita, ravi, none], NOW)
  assert.deepEqual(a.traders, [{ trader: 'gita', totals: none.totals }, { trader: 'ravi', totals: ravi.totals }, { trader: 'sita', totals: sita.totals }])
  assert.deepEqual(a.traders.map((t) => [t.trader, t.totals.books, t.totals.mtmDay, t.totals.openPnl]), [['gita', 0, 0, 0], ['ravi', 2, 15000, 12000], ['sita', 1, 2000, 1500]])
})

test("admin: a trader's warnings carry the trader's name; a stock's Day MTM is null if any trader's is, its Open P&L is the sum", () => {
  const ravi = portfolioOf('ravi', [tcs({ mtm: null })], NOW)
  const sita = portfolioOf('sita', [sitaTcs()], NOW)
  const a = adminPortfolioOf([ravi, sita], NOW)
  assert.deepEqual([a.stocks[0]?.mtmDay, a.stocks[0]?.openPnl], [null, 22500])
  assert.deepEqual(a.warnings, ['ravi: TCS: Today is not shown — no MTM block'])
})

// ---- P&L: the book's series net (spec 2026-10-23 R5) ------------------------------------------------------------

/** One live series of a book: only its expiry and net matter here. */
function seriesOf(expiry: string, net: number | null): SeriesPnl {
  return {
    expiry, open: net === null ? null : net - 100, booked: 200, gross: net === null ? null : net + 100, charges: 100, net,
    closedContracts: 1, openLegs: 1, from: '2026-10-05', since: null, noLtp: net === null ? ['k'] : [], notes: [],
  }
}

/** The view with its series and their total, as `buildBookView` carries them. */
function withSeries(view: BookView, list: readonly SeriesPnl[]): BookView {
  const known = list.every((x) => x.net !== null)
  return {
    ...view, series: list,
    seriesTotal: {
      open: null, booked: 0, gross: null, charges: 0, net: known ? list.reduce((t, x) => t + (x.net as number), 0) : null,
      closedContracts: 0, from: '2026-10-05', ratesConfirmed: true, notes: [],
    },
  }
}

test("P&L is the book's series net; each month row its expiry's net, a closed-out live series its own row; the shares none", () => {
  const view = withSeries(viewOf('TCS', 4000, [
    leg('option', OCT, { delta: 500, gamma: -2, vega: 700, theta: -2000, mtm: 9000 }),
    leg('share', '', { delta: 175, gamma: 0, vega: 0, theta: 0, mtm: 1750 }),
  ]), [seriesOf(OCT, -18023), seriesOf(NOV, 4000)])
  const r = portfolioOf('ravi', [tcs({ view })], NOW).rows[0]
  assert.deepEqual([r?.pnl, r?.pnlReason, r?.openPnl, r?.mtmDay], [-14023, null, 10750, 25000], 'P&L, Today and the legs each their own figure')
  assert.deepEqual(r?.months.map((m) => [m.expiry, m.pnl, m.delta, m.mtm]), [[OCT, -18023, 500, 9000], [NOV, 4000, 0, 0], ['', null, 175, 1750]])
})

test('P&L unknown says why: an open leg with no LTP, no live expiry, no series from the server', () => {
  const legs = [leg('option', OCT, { delta: 500, gamma: -2, vega: 700, theta: -2000, mtm: 9000 })]
  const row = (view: BookView) => portfolioOf('ravi', [tcs({ view })], NOW).rows[0]
  const noLtp = row(withSeries(viewOf('TCS', 4000, legs), [seriesOf(OCT, null)]))
  assert.deepEqual([noLtp?.pnl, noLtp?.pnlReason, noLtp?.months[0]?.pnl], [null, 'an open leg has no LTP', null])
  const shares = row(withSeries(viewOf('TCS', 4000, [leg('share', '', { delta: 175, gamma: 0, vega: 0, theta: 0, mtm: 1750 })]), []))
  assert.deepEqual([shares?.pnl, shares?.pnlReason], [null, 'no live expiry'])
  const none = row(viewOf('TCS', 4000, legs))
  assert.deepEqual([none?.pnl, none?.pnlReason], [null, 'no series'])
})

test("P&L totals and the stock roll-up are sums, unknown as soon as one book's is", () => {
  const tcsView = withSeries(tcs().view, [seriesOf(OCT, -18023)])
  const niftyView = withSeries(nifty().view, [seriesOf(NIFTY_W2, 5000)])
  const ravi = portfolioOf('ravi', [tcs({ view: tcsView }), nifty({ view: niftyView })], NOW)
  assert.equal(ravi.totals.pnl, -13023)
  const sita = portfolioOf('sita', [{ ...sitaTcs(), view: withSeries(sitaTcs().view, [seriesOf(OCT, 1500)]) }], NOW)
  const a = adminPortfolioOf([ravi, sita], NOW)
  assert.deepEqual(a.stocks.map((x) => [x.stock, x.pnl]), [['NIFTY', 5000], ['TCS', -16523]])
  assert.deepEqual(a.traders.map((t) => [t.trader, t.totals.pnl]), [['ravi', -13023], ['sita', 1500]])
  const unknown = portfolioOf('ravi', [tcs({ view: withSeries(tcs().view, [seriesOf(OCT, null)]) }), nifty({ view: niftyView })], NOW)
  assert.equal(unknown.totals.pnl, null, 'a total of the known ones would read as the whole')
  assert.deepEqual(adminPortfolioOf([unknown, sita], NOW).stocks.map((x) => [x.stock, x.pnl]), [['NIFTY', 5000], ['TCS', null]])
})

test('a shares-only book has no P&L to count: left out of every sum, never making it unknown; said once', () => {
  const shares = { ...nifty(), view: withSeries(viewOf('INFY', 1500, [leg('share', '', { delta: 500, gamma: 0, vega: 0, theta: 0, mtm: 2500 })]), []) }
  const priced = tcs({ view: withSeries(tcs().view, [seriesOf(OCT, -18023)]) })
  const ravi = portfolioOf('ravi', [shares, priced], NOW)
  assert.deepEqual(ravi.rows.map((r) => [r.stock, r.pnl, r.pnlReason]), [['INFY', null, 'no live expiry'], ['TCS', -18023, null]])
  assert.equal(ravi.totals.pnl, -18023)
  assert.equal(ravi.warnings.filter((w) => w === SHARES_NOT_IN_PNL).length, 1)
  // the stock roll-up and the trader totals: the shares-only row adds nothing
  const sita = portfolioOf('sita', [{ ...sitaTcs(), view: withSeries(sitaTcs().view, [seriesOf(OCT, 1500)]) }, { ...shares }], NOW)
  const a = adminPortfolioOf([ravi, sita], NOW)
  assert.deepEqual(a.stocks.map((x) => [x.stock, x.pnl, x.pnlReason]), [['INFY', null, 'no live expiry'], ['TCS', -16523, null]])
  assert.deepEqual(a.traders.map((t) => [t.trader, t.totals.pnl]), [['ravi', -18023], ['sita', 1500]])
  // a real unknown still makes the sum unknown
  const noLtp = portfolioOf('ravi', [shares, tcs({ view: withSeries(tcs().view, [seriesOf(OCT, null)]) })], NOW)
  assert.deepEqual([noLtp.totals.pnl, noLtp.totals.pnlReason], [null, 'an open leg has no LTP'])
  assert.equal(adminPortfolioOf([noLtp], NOW).stocks.find((x) => x.stock === 'TCS')?.pnl, null)
  // no shares held: no line
  assert.equal(portfolioOf('ravi', [priced], NOW).warnings.includes(SHARES_NOT_IN_PNL), false)
})

test('a P&L sum with nothing to count is null with its reason, never 0: shares only reads as no P&L, not as flat', () => {
  const shares = (stock: string) => ({ ...nifty(), view: withSeries(viewOf(stock, 1500, [leg('share', '', { delta: 500, gamma: 0, vega: 0, theta: 0, mtm: 2500 })]), []) })
  const lalit = portfolioOf('lalit', [shares('INFY'), shares('ITC')], NOW)
  assert.deepEqual([lalit.totals.pnl, lalit.totals.pnlReason], [null, 'no live expiry'])
  const a = adminPortfolioOf([lalit], NOW)
  assert.deepEqual(a.stocks.map((x) => [x.stock, x.pnl, x.pnlReason]), [['INFY', null, 'no live expiry'], ['ITC', null, 'no live expiry']])
  assert.deepEqual(a.traders.map((t) => [t.trader, t.totals.pnl]), [['lalit', null]])
})
