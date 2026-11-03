import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isTradingDay } from '@algomaker/desk-engine'
import { b76Price, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE, legPnl, legPoints, scenario, scenarioAxes, type Axes, type PayoffLeg, type ScenarioMarket, type VolShifts } from '@algomaker/payoff'
import { eodKey, type EodContract } from '@algomaker/span'
import { SEED_RATES } from '../src/analytics/charges.ts'
import { EodStore } from '../src/analytics/eod.ts'
import { dayLegs, mtmBlock, type MtmInputs } from '../src/analytics/mtm.ts'
import {
  DAY_BASE_NOTE, NET_BASE_NOTE, buildScenario, buildScenarioView, parseScenarioRequest, resolveHypothetical,
} from '../src/analytics/scenario-view.ts'
import { MARKET_CLOSED, SnapshotCache, chainIvs, priceBook, type BookSnapshot } from '../src/analytics/snapshot.ts'
import type { HypotheticalLeg, ScenarioRequest, ScenarioView } from '../src/analytics/wire.ts'
import { TradersDb } from '../src/db.ts'
import type { TradersDeps } from '../src/deps.ts'
import { buildTradersMaster } from '../src/market/master.ts'
import type { TradersQuotes } from '../src/market/quotes.ts'
import type { TraderLeg } from '../src/types.ts'
import { testMaster } from './fixtures/master.ts'
import {
  L1, L2, L3, L4, L5, R2_DEC, R2_NOV, R2_NOW, R2_OCT, TM, futLeg, optLeg, r2Legs, r2Market, r2Master, r2Quotes, shareLeg,
} from './fixtures/r2-book.ts'

function close(a: number | null | undefined, b: number | null | undefined, eps: number): void {
  assert.ok(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps, `${a} vs ${b} (eps ${eps})`)
}

/** Visits every number in a JSON value. */
function walkNumbers(x: unknown, fn: (n: number, path: string) => void, path = 'view'): void {
  if (typeof x === 'number') fn(x, path)
  else if (Array.isArray(x)) x.forEach((v, i) => walkNumbers(v, fn, `${path}[${i}]`))
  else if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) walkNumbers(v, fn, `${path}.${k}`)
}
const allFinite = (x: unknown): void => walkNumbers(x, (n, path) => assert.ok(Number.isFinite(n), `${path} = ${n}`))

const S = priceBook('asha', 'TCS', r2Legs(), r2Market())
const H: HypotheticalLeg = { id: 'h1', instrument: 'option', expiry: R2_OCT, strike: 3100, optType: 'PE', qty: -175, price: null, iv: null }
const err = (x: unknown): string => (x as { error: string }).error
const view = (x: ScenarioView | { readonly error: string }): ScenarioView => {
  assert.ok(!('error' in x), `expected a view, got ${JSON.stringify(x)}`)
  return x
}
const noQuotes: TradersQuotes = { quote: () => null, feedAlive: () => true }

/** The pinned book's market as the payoff package takes it: Oct future 3010, Nov 3030, both on their own future. */
const MARKET: ScenarioMarket = { spot: 3000, futures: { [R2_OCT]: 3010, [R2_NOV]: 3030 }, optionFutures: { [R2_OCT]: 3010, [R2_NOV]: 3030 }, now: R2_NOW }

/** The grid axes for the pinned book: M.Strike 3000 (ATM at the Oct forward 3010), CMP 3000, today to the near expiry. */
function axesOf(o: { stepPct?: number; count?: number; everyNth?: number } = {}): Axes {
  const a = scenarioAxes({
    middle: 3000, stepPct: o.stepPct ?? 0.5, count: o.count ?? 50, spot: 3000, start: '2026-10-19', end: R2_OCT,
    everyNth: o.everyNth ?? 1, expiry: R2_OCT, now: R2_NOW, isTradingDay,
  })
  assert.ok(!('error' in a), JSON.stringify(a))
  return a
}

/** MtmInputs over `s` with no trades: every leg carried, yesterday's close of the Oct future 3005 (Task 5's end-of-day fixture), nothing else known. */
function inputsFor(s: BookSnapshot): MtmInputs {
  const live = new Map(s.legs.map((l) => [eodKey(l.leg), l.ltp]))
  return {
    legs: s.legs, unmatchedKeys: s.unmatchedKeys, todayTrades: [], earlierTrades: [],
    ltpOf: (c: EodContract) => live.get(eodKey(c)) ?? null,
    closeOf: (c: EodContract) => (c.instrument === 'future' && c.expiry === R2_OCT ? 3005 : null),
    eodMissing: [], bse: false, lotSizeOf: () => 175, rates: SEED_RATES, trader: 'asha', pastSession: null, nowMs: R2_NOW,
  }
}

test('defaults are resolved and echoed', () => {
  const v = buildScenario(S, {}, [], [], null) as ScenarioView
  assert.deepEqual(v.resolved, { spot: 3000, callVolShift: 0, putVolShift: 0, volShift: 0, start: '2026-10-19', end: '2026-10-27', everyNth: 1, middle: 3000, stepPct: 0.5, count: 50, targetDate: '2026-10-19' })
  assert.deepEqual([v.grid.labels, v.grid.spots.length, v.grid.currentRow], [['19 Oct', '21 Oct', '22 Oct', '23 Oct', '26 Oct', '27 Oct', 'Expiry'], 101, 50])
  assert.deepEqual(v.totals, v.grid.cells[50]![0]); assert.equal(v.legs.length, 5)
  // the header, the dates under the labels (Tue 20 Oct is Dussehra), and the net-price base with no day legs
  assert.deepEqual([v.stock, v.asOf, v.closed, v.nearExpiry, v.lastExpiry, v.expiries, v.lotSize, v.lotGcd], ['TCS', R2_NOW, false, R2_OCT, R2_NOV, [R2_OCT, R2_NOV, R2_DEC], 175, 1])
  assert.deepEqual(v.grid.dates, ['2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', R2_OCT])
  assert.deepEqual([v.grid.spots[0], v.grid.spots[50], v.grid.spots[100]], [2250, 3000, 3750])   // ±25 % in 0.5 % steps
  assert.deepEqual([v.baseNote, v.hypothetical], [NET_BASE_NOTE, []])
  assert.equal(NET_BASE_NOTE, 'Grid, chart and table: P&L against net price — yesterday\'s close is unknown (see the MTM block)')
})

test('a closed market is said once: the view\'s closed flag, never a warning beside it (final fix M5)', () => {
  const evening = priceBook('asha', 'TCS', r2Legs(), r2Market({ now: Date.UTC(2026, 9, 19, 11, 0) }))   // 16:30 IST
  assert.ok(evening.warnings.includes(MARKET_CLOSED))
  const v = view(buildScenario(evening, {}, [], [], null))
  assert.equal(v.closed, true)
  assert.equal(v.warnings.includes(MARKET_CLOSED), false)
})

test('the grid’s top row equals Gross MTM total at LTP, as VolHedge (16188 = 16188 on its screen)', () => {
  const book = priceBook('asha', 'TCS', [futLeg(-1750)], r2Market())                  // carried; previous close 3005, LTP 3010
  const v = buildScenario(book, {}, [], [], dayLegs(inputsFor(book))!) as ScenarioView   // inputsFor: MtmInputs with no trades today, closeOf(Oct FUT) = 3005
  close(v.totals.pnl, mtmBlock(inputsFor(book)).gross.total, 1e-9); close(v.totals.pnl, -8750, 1e-9)
  // by hand: −1750 carried × (3010 Oct future at CMP 3000 − 3005 yesterday's close) = −1750 × 5 = −8750
  assert.equal(v.baseNote, DAY_BASE_NOTE)
  assert.equal(DAY_BASE_NOTE, 'Grid: P&L since yesterday\'s close (carried legs) and since the fill (today\'s trades), as VolHedge. Chart and table: P&L against net price, as Sensibull.')
  // the chart and the table are against net price (3000): −1750 × (3010 − 3000) at spot
  close(v.table.find((r) => r.label === 'spot')!.target, -17500, 1e-9)
  // the leg table's rate is the net price; the grid's base is yesterday's close
  assert.deepEqual([v.legs[0]!.rate, v.legs[0]!.type, v.legs[0]!.underlying, v.legs[0]!.ltp], [3000, 'F', 3010, 3010])
})

test('the day base: offset and day entries reach every grid cell, never the chart or table', () => {
  const day = { legs: S.legs.map((l, i) => ({ ...l.payoff, entry: l.payoff.entry + i + 1 })), offset: 525 }
  const onDay = view(buildScenario(S, {}, [], [], day))
  const net = view(buildScenario(S, {}, [], [], null))
  // each leg's entry is i+1 higher: every cell moves by 525 − Σ qty × (i+1)
  const shift = 525 - S.legs.reduce((s, l, i) => s + l.leg.qty * (i + 1), 0)
  onDay.grid.cells.forEach((row, r) => row.forEach((c, k) => close(c.pnl - net.grid.cells[r]![k]!.pnl, shift, 1e-6)))
  assert.deepEqual([onDay.chart, onDay.table, onDay.legs], [net.chart, net.table, net.legs])
  assert.equal(onDay.baseNote, DAY_BASE_NOTE)
})

test('grid cells are scenario() at the axes', () => {
  const req: ScenarioRequest = { volShift: 2, callVolShift: 1, putVolShift: -1, stepPct: 1, count: 10, everyNth: 2 }
  const v = view(buildScenario(S, req, [], [], null))
  const axes = axesOf({ stepPct: 1, count: 10, everyNth: 2 })
  const shifts: VolShifts = { volShift: 2, callVolShift: 1, putVolShift: -1, ivOverrides: {} }
  const want = scenario(S.legs.map((l) => l.payoff), MARKET, axes.spots, axes.columns, shifts)
  assert.deepEqual([v.grid.spots, v.grid.currentRow, v.grid.labels, v.grid.dates], [axes.spots, axes.currentRow, axes.labels, axes.columns.map((c) => c.date)])
  assert.deepEqual(v.grid.labels, ['19 Oct', '22 Oct', '26 Oct', 'Expiry'])   // every 2nd trading day
  assert.deepEqual(v.grid.cells, want.cells)
  assert.deepEqual(v.totals, want.cells[axes.currentRow]![0])
})

test('the Expiry column is the near month and far legs keep time value (Review Focus 1)', () => {
  // L2-only book: cell at (3000, 'Expiry') === legPnl(L2 payoff, 3030, 27/365)
  const nov = priceBook('asha', 'TCS', [optLeg(R2_NOV, 3000, 'CE', 175, 80)], r2Market())
  const v = view(buildScenario(nov, {}, [], [], null))
  const col = v.grid.labels.indexOf('Expiry')
  const row = v.grid.spots.indexOf(3000)
  assert.deepEqual([v.nearExpiry, v.lastExpiry, v.grid.dates[col], row], [R2_OCT, R2_NOV, R2_OCT, 50])
  const leg = nov.legs[0]!.payoff
  const atClose = legPnl(leg, 3030, 27 / 365)   // the Nov future at spot 3000; 27 days from the Oct close to the Nov close
  close(v.grid.cells[row]![col]!.pnl, atClose, 1e-9)
  assert.ok(atClose > legPnl(leg, 3030, 0) + 175 * 10, 'the Nov leg is not valued at intrinsic on the Oct expiry')
})

test('an excluded leg leaves the grid', () => {
  // exclude [L1] → every cell differs by exactly L1's own pnl at that point
  const all = view(buildScenario(S, {}, [], [], null))
  const ex = view(buildScenario(S, { exclude: [L1] }, [], [], null))
  const axes = axesOf()
  const own = scenario([S.legs[0]!.payoff], MARKET, axes.spots, axes.columns, {})
  all.grid.cells.forEach((row, r) => row.forEach((c, k) => {
    close(c.pnl - ex.grid.cells[r]![k]!.pnl, own.cells[r]![k]!.pnl, 1e-6)
    close(c.delta - ex.grid.cells[r]![k]!.delta, own.cells[r]![k]!.delta, 1e-6)
  }))
  close(all.totals.pnl - ex.totals.pnl, own.cells[50]![0]!.pnl, 1e-6)
  // its row stays in the leg table (the page shows it muted, as Analysis ticks it), and the chart leaves it out too
  assert.deepEqual(ex.legs.map((l) => l.id), all.legs.map((l) => l.id))
  assert.notDeepEqual(ex.chart.points, all.chart.points)
})

test('a hypothetical joins the scenario', () => {
  const r = resolveHypothetical({ id: 'h1', instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: null, iv: null }, S, r2Market())
  assert.deepEqual([r.view.accepted, r.view.entry], [true, 120]); assert.equal(r.view.iv, S.chains['2026-10-27']!.find((x) => x.strike === 3100 && x.type === 'PE')!.iv)
  assert.deepEqual(r.leg, { id: 'h1', instrument: 'option', qty: -175, strike: 3100, type: 'PE', expiry: R2_OCT, entry: 120, iv: r.view.iv })
  assert.equal(r.view.reason, null)
  // every cell moves by exactly the hypothetical's own P&L; its row comes after the book's, with its own id
  const base = view(buildScenario(S, {}, [], [], null))
  const v = view(buildScenario(S, {}, [r.leg!], [r.view], null))
  const axes = axesOf()
  const own = scenario([r.leg!], MARKET, axes.spots, axes.columns, {})
  v.grid.cells.forEach((row, i) => row.forEach((c, k) => close(c.pnl - base.grid.cells[i]![k]!.pnl, own.cells[i]![k]!.pnl, 1e-6)))
  assert.deepEqual(v.legs.map((l) => [l.id, l.hypothetical]), [...S.legs.map((l) => [l.leg.key, false]), ['h1', true]])
  const h = v.legs.at(-1)!
  assert.deepEqual([h.type, h.expiry, h.strike, h.qty, h.rate, h.ltp, h.underlying, h.vol], ['P', R2_OCT, 3100, -175, 120, 120, 3010, r.view.iv])
  close(h.deltaValue, h.delta * -175, 1e-9)
  assert.deepEqual(v.hypothetical, [r.view])
  assert.notDeepEqual(v.chart.points, base.chart.points)
  // lotGcd covers it: two lots short of the Oct future and one hypothetical lot → 1; alone with a 2-lot leg → 1
  const lots = priceBook('asha', 'TCS', [futLeg(-350)], r2Market())
  assert.equal(view(buildScenario(lots, {}, [], [], null)).lotGcd, 2)
  assert.equal(view(buildScenario(lots, {}, [r.leg!], [r.view], null)).lotGcd, 1)
})

test('an unlisted strike is refused with a reason', () =>
  assert.equal(resolveHypothetical({ id: 'h2', instrument: 'option', expiry: '2026-10-27', strike: 3050, optType: 'CE', qty: -175, price: null, iv: null }, S, r2Market()).view.reason, 'TCS 2026-10-27 3050 CE is not listed'))

test('a month with no IV needs one typed', () => {
  const h = { id: 'h3', instrument: 'option', expiry: '2026-12-29', strike: 3000, optType: 'CE', qty: 175, price: null, iv: null } as const
  assert.equal(resolveHypothetical(h, S, r2Market()).view.reason, 'no IV for 2026-12-29 — type one')
  assert.equal(resolveHypothetical({ ...h, iv: 0.25 }, S, r2Market()).view.accepted, true)
  // Dec is unquoted: no future, no two-sided strike, so it is solved on demand off spot carried; the rate is the model at the typed IV
  const r = resolveHypothetical({ ...h, iv: 0.25 }, S, r2Market())
  const dec = chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', R2_DEC, R2_NOW)!
  assert.equal(dec.source, 'carry')
  close(r.view.entry, b76Price({ future: dec.forward!, strike: 3000, t: yearsToExpiry(R2_DEC, R2_NOW), vol: 0.25, rate: DEFAULT_RATE, type: 'CE' }), 1e-9)
  assert.deepEqual([r.view.iv, r.leg?.iv, r.leg?.expiry], [0.25, 0.25, R2_DEC])
  // a typed rate wins over the model
  assert.equal(resolveHypothetical({ ...h, iv: 0.25, price: 0 }, S, r2Market()).view.entry, 0)
  assert.deepEqual(resolveHypothetical(h, S, r2Market()), { leg: null, view: { id: 'h3', accepted: false, reason: 'no IV for 2026-12-29 — type one', entry: null, iv: null } })
})

test('futures and shares: rate typed, else the quote, else the forward or spot; an index has no shares', () => {
  const fut = (expiry: string, price: number | null = null): HypotheticalLeg => ({ id: 'f1', instrument: 'future', expiry, strike: null, optType: null, qty: 175, price, iv: null })
  assert.deepEqual(resolveHypothetical(fut(R2_NOV), S, r2Market()).leg, { id: 'f1', instrument: 'future', qty: 175, strike: null, type: null, expiry: R2_NOV, entry: 3030, iv: null })
  assert.equal(resolveHypothetical(fut(R2_NOV, 3025), S, r2Market()).view.entry, 3025)
  const dec = chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', R2_DEC, R2_NOW)!
  close(resolveHypothetical(fut(R2_DEC), S, r2Market()).view.entry, dec.forward, 1e-9)                  // unquoted: the month's forward
  assert.equal(resolveHypothetical(fut('2027-01-26'), S, r2Market()).view.reason, 'TCS 2027-01-26 FUT is not listed')
  assert.equal(resolveHypothetical(fut('2026-09-29'), S, r2Market()).view.reason, 'TCS 2026-09-29 FUT has expired')
  const share: HypotheticalLeg = { id: 's1', instrument: 'share', expiry: '', strike: null, optType: null, qty: 100, price: null, iv: null }
  assert.deepEqual(resolveHypothetical(share, S, r2Market()).leg, { id: 's1', instrument: 'future', qty: 100, strike: null, type: null, expiry: '', entry: 3000, iv: null })
  assert.equal(resolveHypothetical({ ...share, price: 2990 }, S, r2Market()).view.entry, 2990)
  const blind = priceBook('asha', 'TCS', r2Legs(), { master: () => TM, quotes: noQuotes, now: () => R2_NOW })
  assert.equal(resolveHypothetical(share, blind, { master: () => TM, quotes: noQuotes, now: () => R2_NOW }).view.reason, 'no price for TCS — type a rate')
  // a share row on the leg table: EQ, priced at spot
  const r = resolveHypothetical(share, S, r2Market())
  const row = view(buildScenario(S, {}, [r.leg!], [r.view], null)).legs.at(-1)!
  assert.deepEqual([row.type, row.expiry, row.underlying, row.rate, row.ltp, row.delta, row.vol], ['EQ', '', 3000, 3000, 3000, 1, null])
})

test('a share hypothetical on an index underlying is refused, decided from the master (Ruling)', () => {
  const share: HypotheticalLeg = { id: 's1', instrument: 'share', expiry: '', strike: null, optType: null, qty: 65, price: null, iv: null }
  const m = { master: () => testMaster(), quotes: noQuotes, now: () => R2_NOW }
  for (const index of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
    const s = priceBook('asha', index, [], m)
    for (const h of [share, { ...share, price: 25000 }]) {
      assert.deepEqual(resolveHypothetical(h, s, m), { leg: null, view: { id: 's1', accepted: false, reason: `${index} is an index — no shares`, entry: null, iv: null } }, `${index} ${h.price}`)
    }
  }
  // a stock with an NSE cash-equity row in the same master takes shares; its index options are still fine on NIFTY
  const tcs = priceBook('asha', 'TCS', [], m)
  assert.deepEqual(resolveHypothetical({ ...share, price: 3400 }, tcs, m).view, { id: 's1', accepted: true, reason: null, entry: 3400, iv: null })
  const nifty = priceBook('asha', 'NIFTY', [], m)
  assert.equal(resolveHypothetical({ id: 'o1', instrument: 'option', expiry: '2026-10-20', strike: 25000, optType: 'CE', qty: 65, price: 120, iv: 0.12 }, nifty, m).view.accepted, true)
  // Ruling (fix round 1): no NSE cash-equity row in the master is no shares, whatever the name — not an index, so said plainly
  const noCash = buildTradersMaster(r2Master().filter((r) => r.instrument_type !== 'EQ'), 0)
  const bare = { master: () => noCash, quotes: r2Quotes(), now: () => R2_NOW }
  assert.deepEqual(resolveHypothetical({ ...share, price: 3000 }, priceBook('asha', 'TCS', [], bare), bare).view,
    { id: 's1', accepted: false, reason: 'TCS has no cash-equity row in the instrument master — no shares', entry: null, iv: null })
  // an F&O index outside R1's index-spot table: its listed options and its INDICES row, no cash row — refused too
  const nxt = buildTradersMaster([
    { instrument_token: 270857, tradingsymbol: 'NIFTY NEXT 50', name: 'NIFTY NEXT 50', expiry: '', strike: 0, tick_size: 0.05, lot_size: 0, instrument_type: 'EQ', segment: 'INDICES', exchange: 'NSE' },
    ...(['CE', 'PE'] as const).map((type, i) => ({
      instrument_token: 9000 + i, tradingsymbol: `NIFTYNXT5026OCT70000${type}`, name: 'NIFTYNXT50', expiry: R2_OCT, strike: 70000,
      tick_size: 0.05, lot_size: 25, instrument_type: type, segment: 'NFO-OPT', exchange: 'NFO',
    })),
  ], 0)
  const nm = { master: () => nxt, quotes: noQuotes, now: () => R2_NOW }
  const n50 = priceBook('asha', 'NIFTYNXT50', [], nm)
  assert.equal(n50.nearExpiry, R2_OCT)
  assert.deepEqual(resolveHypothetical({ ...share, price: 70000 }, n50, nm).view,
    { id: 's1', accepted: false, reason: 'NIFTYNXT50 has no cash-equity row in the instrument master — no shares', entry: null, iv: null })
  assert.equal(resolveHypothetical({ id: 'o1', instrument: 'option', expiry: R2_OCT, strike: 70000, optType: 'CE', qty: 25, price: 900, iv: 0.15 }, n50, nm).view.accepted, true)
})

test('an unquoted future prices at its month’s forward, held or hypothetical: no phantom P&L (Ruling, fix round 1)', () => {
  // the Oct future unquoted: Oct is valued on its parity forward (3000 strike, CE 60 − PE 50), and so is the Oct future
  const s = priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { 10: null } }))
  const fwd = s.optionFutures[R2_OCT]!
  assert.ok(fwd > 3005 && fwd < 3015 && s.futures[R2_OCT] === null, String(fwd))
  const base = view(buildScenario(s, {}, [], [], null))
  assert.equal(base.legs.find((l) => l.id === L4)!.underlying, fwd)
  assert.ok(!base.warnings.includes(`no future for ${R2_OCT}: its legs price off spot`), JSON.stringify(base.warnings))
  // L4 (+175 @3000) at CMP is worth the forward, not spot
  const l4 = view(buildScenario(s, { exclude: [L1, L2, L3, L5] }, [], [], null))
  close(l4.totals.pnl, 175 * (fwd - 3000), 1e-9)
  // a hypothetical Oct future with no rate enters at that same forward: nothing at CMP and now
  const fut: HypotheticalLeg = { id: 'f1', instrument: 'future', expiry: R2_OCT, strike: null, optType: null, qty: 1750, price: null, iv: null }
  const r = resolveHypothetical(fut, s, r2Market({ quotes: { 10: null } }))
  assert.equal(r.view.entry, fwd)
  close(view(buildScenario(s, {}, [r.leg!], [r.view], null)).totals.pnl, base.totals.pnl, 1e-6)
})

test('a future with no quote valued at its forward says so once per month, a hypothetical one too (fix round 2)', () => {
  const note = '27 Oct future unquoted — valued at its forward'
  const unq = r2Market({ quotes: { 10: null } })
  const s = priceBook('asha', 'TCS', r2Legs(), unq)
  assert.deepEqual(view(buildScenario(s, {}, [], [], null)).warnings.filter((w) => w === note), [note])
  assert.ok(!view(buildScenario(s, { exclude: [L4] }, [], [], null)).warnings.includes(note))
  // only the Oct CE held: no future valued, no note — until a hypothetical Oct future joins
  const ce = priceBook('asha', 'TCS', [r2Legs()[0]!], unq)
  assert.ok(!view(buildScenario(ce, {}, [], [], null)).warnings.includes(note))
  const r = resolveHypothetical({ id: 'f1', instrument: 'future', expiry: R2_OCT, strike: null, optType: null, qty: 175, price: null, iv: null }, ce, unq)
  assert.deepEqual(view(buildScenario(ce, {}, [r.leg!], [r.view], null)).warnings.filter((w) => w === note), [note])
  // quoted: no note
  assert.ok(!view(buildScenario(S, {}, [], [], null)).warnings.some((w) => w.includes('future unquoted')))
})

test('the leg table: each leg at CMP and the first column, per share and × qty', () => {
  const v = view(buildScenario(S, { callVolShift: 2 }, [], [], null))
  const pts = legPoints(S.legs.map((l) => l.payoff), MARKET, { spot: 3000, point: { date: '2026-10-19', ms: R2_NOW } }, { callVolShift: 2, putVolShift: 0, volShift: 0, ivOverrides: {} })
  const l1 = v.legs[0]!
  assert.deepEqual([l1.id, l1.hypothetical, l1.expiry, l1.type, l1.underlying, l1.strike, l1.qty, l1.rate, l1.ltp], [L1, false, R2_OCT, 'C', 3010, 3000, -175, 50, 60])
  close(l1.vol, S.legs[0]!.marketIv! + 0.02, 1e-12)
  assert.deepEqual([l1.delta, l1.gamma, l1.vega, l1.theta], [pts[0]!.delta, pts[0]!.gamma, pts[0]!.vega, pts[0]!.theta])
  close(l1.vegaValue, l1.vega * -175, 1e-9); close(l1.thetaValue, l1.theta * -175, 1e-9); close(l1.gammaValue, l1.gamma * -175, 1e-12)
  assert.deepEqual(v.legs.map((l) => [l.id, l.type, l.underlying]), [[L1, 'C', 3010], [L2, 'C', 3030], [L3, 'C', 3010], [L4, 'F', 3010], [L5, 'EQ', 3000]])
  // the leg table at a typed CMP: each forward moves with it
  const up = view(buildScenario(S, { spot: 3030 }, [], [], null))
  close(up.legs[1]!.underlying, 3030 * 3030 / 3000, 1e-9); assert.equal(up.legs[4]!.underlying, 3030)
  assert.equal(up.grid.spots[up.grid.currentRow], 3030)
  assert.equal(up.chart.spot, 3030); close(up.table.find((r) => r.label === 'spot')!.price, 3030, 1e-9)
})

test('viewer ticks, typed IVs and unknown keys apply as in Analysis (Review Focus 3)', () => {
  const plain = view(buildScenario(S, {}, [], [], null))
  assert.deepEqual(buildScenario(S, { exclude: ['bala|future|TCS|2026-10-27||'], illiquid: [L4, 'x'], ivOverrides: { [L5]: 0.3, zz: 0.3 } }, [], [], null), plain)
  const ticked = view(buildScenario(S, { illiquid: [L1] }, [], [], null))
  const otherSide = S.chains[R2_OCT]!.find((x) => x.strike === 3000 && x.type === 'PE')!.iv
  close(ticked.legs[0]!.vol, otherSide, 1e-12)
  assert.notDeepEqual(ticked.grid.cells, plain.grid.cells)
  const typed = view(buildScenario(S, { ivOverrides: { [L1]: 0.3 }, volShift: 1 }, [], [], null))
  close(typed.legs[0]!.vol, 0.31, 1e-12)
})

test('chart and Sensibull table present', () => {
  const v = buildScenario(S, {}, [], [], null) as ScenarioView
  assert.deepEqual([v.chart.points.length, v.chart.expiryDate], [121, '2026-10-27']); assert.ok(v.table.some((r) => r.label === 'spot'))
  assert.deepEqual([v.chart.targetDate, v.chart.spot], ['2026-10-19', 3000])
  const t = view(buildScenario(S, { targets: [3100, 2900.5], targetDate: R2_NOV }, [], [], null))
  assert.deepEqual(t.table.map((r) => r.label), ['-8%', '-5%', 'target 2900.5', '-3%', '-2%', '-1%', 'spot', '+1%', '+2%', '+3%', 'target 3100', '+5%', '+8%'])
  assert.equal(t.chart.targetDate, R2_NOV)
  assert.notDeepEqual(t.chart.points.map((p) => p.target), v.chart.points.map((p) => p.target))
})

test('no listed expiry is its own error; no spot price needs a typed CMP', () => {
  const bstock = { ...shareLeg(10, 'manual:b1'), stock: 'BSTOCK' }
  assert.deepEqual(buildScenario(priceBook('asha', 'BSTOCK', [bstock], r2Market()), {}, [], [], null), { error: 'BSTOCK has no listed expiry' })
  const blind = priceBook('asha', 'TCS', r2Legs(), { master: () => TM, quotes: noQuotes, now: () => R2_NOW })
  assert.match(err(buildScenario(blind, {}, [], [], null)), /^spot/)
  // with a typed CMP the book is valued around it, and the view says why
  const v = view(buildScenario(blind, { spot: 3000 }, [], [], null))
  assert.ok(v.warnings.includes('no spot price for TCS — the scenario is valued around the typed CMP 3000'), JSON.stringify(v.warnings))
  allFinite(v)
})

test('the warnings: the snapshot’s, then what scenario() names, once each', () => {
  const v = view(buildScenario(S, { volShift: -50 }, [], [], null))
  assert.ok(v.warnings.some((w) => w.startsWith(`leg ${L1}: IV shifted to`)), JSON.stringify(v.warnings))
  assert.equal(new Set(v.warnings).size, v.warnings.length)
  const dead = priceBook('asha', 'TCS', r2Legs(), r2Market({ feedAlive: false }))
  assert.equal(view(buildScenario(dead, {}, [], [], null)).warnings[0], dead.warnings[0])
})

/** The pinned book with every lot set to `lot`. */
function lotBook(lot: number): BookSnapshot {
  const m = buildTradersMaster(r2Master().map((r) => ({ ...r, lot_size: lot })), 0)
  return priceBook('asha', 'TCS', [futLeg(-1750), optLeg(R2_OCT, 3000, 'CE', -175, 50)], { master: () => m, quotes: r2Quotes(), now: () => R2_NOW })
}

test('every number in the view is finite (Review Focus 4)', () => {
  // walkNumbers(json, fn) visits every number in a JSON value
  for (const req of [{ volShift: -50 }, { spot: 0.01 }, { targetDate: '2026-11-23' }]) walkNumbers(buildScenario(S, req, [], [], null), (n) => assert.ok(Number.isFinite(n)))
  const books: BookSnapshot[] = [
    S,
    lotBook(0),
    priceBook('asha', 'TCS', r2Legs(), { master: () => TM, quotes: noQuotes, now: () => R2_NOW }),
    priceBook('asha', 'TCS', [optLeg(R2_DEC, 3000, 'CE', -175, 40), futLeg(175)], r2Market()),
    priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { 10: null, 11: null } })),
    priceBook('asha', 'TCS', r2Legs(), r2Market({ now: Date.UTC(2026, 9, 19, 12, 0) })),   // 17:30 IST: closed
  ]
  const hyps = [H, { ...H, id: 'h2', expiry: R2_DEC, strike: 3000, optType: 'CE', iv: 5 }, { ...H, id: 'h3', iv: 0.0001, price: 0 },
    { id: 'h4', instrument: 'future', expiry: R2_DEC, strike: null, optType: null, qty: 9_007_199_254_740_991, price: null, iv: null },
    { id: 'h5', instrument: 'share', expiry: '', strike: null, optType: null, qty: -1, price: 10_000_000, iv: null },
    { ...H, id: 'h6', price: Number.NaN }, { ...H, id: 'h7', iv: Number.NaN }, { ...H, id: 'h8', qty: 0.5 }] as HypotheticalLeg[]
  const reqs: ScenarioRequest[] = [
    {}, { volShift: -50 }, { spot: 0.01 }, { spot: 3000 }, { spot: 10_000_000 }, { targetDate: '2026-11-23' },
    { callVolShift: 50, putVolShift: -50, ivOverrides: { [L1]: 5, [L3]: 0.0001 }, illiquid: [L1, L2, L3], exclude: [L4] },
    { count: 100, stepPct: 100, middle: 10_000_000 }, { count: 0, everyNth: 1000 }, { targets: [0.01, 3000, 10_000_000] },
    { exclude: [L1, L2, L3, L4, L5] },
  ]
  for (const s of books) {
    const resolved = hyps.map((h) => resolveHypothetical(h, s, r2Market()))
    allFinite(resolved.map((r) => r.view))
    const legs = resolved.flatMap((r) => (r.leg === null ? [] : [r.leg]))
    // a day base on every leg: a point under each LTP, and something realised on a contract closed today
    const day = { legs: s.legs.map((l) => ({ ...l.payoff, entry: (l.ltp ?? l.payoff.entry) - 1 })), offset: 525 }
    for (const req of reqs) for (const d of [null, day]) allFinite(buildScenario(s, req, legs, resolved.map((r) => r.view), d))
  }
  // a lot of 0 is no lot: shown as none, and the unit stays 1
  const zero = view(buildScenario(lotBook(0), {}, [], [], null))
  assert.deepEqual([zero.lotSize, zero.lotGcd], [null, 1])
  // what is not finite never gets in: a NaN rate or IV is refused by the parser, naming the field
  assert.match(err(parseScenarioRequest({ hypothetical: [{ ...H, price: Number.NaN }] })), /^hypothetical\[0\]\.price/)
  assert.match(err(parseScenarioRequest({ hypothetical: [{ ...H, iv: Number.POSITIVE_INFINITY }] })), /^hypothetical\[0\]\.iv/)
  assert.match(err(parseScenarioRequest({ spot: Number.NaN })), /^spot/)
  assert.match(err(parseScenarioRequest({ volShift: Number.NaN })), /^volShift/)
  assert.match(err(parseScenarioRequest({ targets: [Number.NaN] })), /^targets/)
})

test('request limits name the field', () => {
  const err = (x: unknown) => (x as { error: string }).error
  assert.match(err(parseScenarioRequest({ hypothetical: Array(21).fill(H) })), /hypothetical/)
  assert.match(err(parseScenarioRequest({ volShift: 60 })), /volShift/)
  assert.match(err(buildScenario(S, { targetDate: '2026-12-01' }, [], [], null)), /targetDate/)   // after the last held expiry
  assert.match(err(buildScenario(S, { count: 101 }, [], [], null)), /count/)
  // the rest of the parser's limits, each naming its field first
  const bad: [unknown, RegExp][] = [
    [[], /^the body/], ['x', /^the body/], [null, /^the body/],
    [{ exclude: 'x' }, /^exclude/], [{ illiquid: [1] }, /^illiquid/], [{ ivOverrides: { [L1]: 0 } }, /^ivOverrides/], [{ ivOverrides: { [L1]: 5.1 } }, /^ivOverrides/],
    [{ spot: 0 }, /^spot/], [{ spot: '3000' }, /^spot/], [{ middle: 10_000_001 }, /^middle/],
    [{ callVolShift: -50.5 }, /^callVolShift/], [{ putVolShift: 51 }, /^putVolShift/],
    [{ start: '2026-10-32' }, /^start/], [{ end: 20261027 }, /^end/], [{ targetDate: '19-10-2026' }, /^targetDate/],
    [{ everyNth: 'all' }, /^everyNth/], [{ count: null }, /^count/], [{ stepPct: 0 }, /^stepPct/], [{ stepPct: 101 }, /^stepPct/],
    [{ targets: [1, 2, 3, 4, 5, 6] }, /^targets/], [{ targets: [0] }, /^targets/], [{ targets: 3000 }, /^targets/],
    [{ hypothetical: H }, /^hypothetical/],
    [{ hypothetical: [{ ...H, id: 'h 1' }] }, /^hypothetical\[0\]\.id/], [{ hypothetical: [{ ...H, id: 'x'.repeat(33) }] }, /^hypothetical\[0\]\.id/],
    [{ hypothetical: [H, H] }, /^hypothetical: id h1/],
    [{ hypothetical: [{ ...H, instrument: 'bond' }] }, /^hypothetical\[0\]\.instrument/],
    [{ hypothetical: [{ ...H, expiry: '' }] }, /^hypothetical\[0\]\.expiry/],
    [{ hypothetical: [{ ...H, strike: null }] }, /^hypothetical\[0\]\.strike/], [{ hypothetical: [{ ...H, optType: 'XX' }] }, /^hypothetical\[0\]\.optType/],
    [{ hypothetical: [{ ...H, qty: 0 }] }, /^hypothetical\[0\]\.qty/], [{ hypothetical: [{ ...H, qty: 1.5 }] }, /^hypothetical\[0\]\.qty/],
    [{ hypothetical: [{ ...H, price: -1 }] }, /^hypothetical\[0\]\.price/], [{ hypothetical: [{ ...H, iv: 0 }] }, /^hypothetical\[0\]\.iv/],
    [{ hypothetical: [{ ...H, iv: 5.5 }] }, /^hypothetical\[0\]\.iv/],
  ]
  for (const [body, re] of bad) assert.match(err(parseScenarioRequest(body)), re, JSON.stringify(body))
  // and the range checks that need the book or the calendar
  const range: [ScenarioRequest, RegExp][] = [
    [{ targetDate: '2026-10-16' }, /^targetDate/], [{ everyNth: 0 }, /^everyNth/], [{ end: '2026-10-19', start: '2026-10-21' }, /^end/],
    [{ start: '2026-10-16' }, /^start/], [{ start: '2026-10-28' }, /^start/], [{ count: 2.5 }, /^count/],
  ]
  for (const [req, re] of range) assert.match(err(buildScenario(S, req, [], [], null)), re, JSON.stringify(req))
  // a hypothetical's month extends the target date's range
  const dec = resolveHypothetical({ ...H, expiry: R2_DEC, strike: 3000, iv: 0.25 }, S, r2Market())
  assert.equal(view(buildScenario(S, { targetDate: '2026-12-01' }, [dec.leg!], [dec.view], null)).lastExpiry, R2_DEC)
})

test('the parser keeps what it was given and fills nothing in', () => {
  const body = {
    exclude: [L1], illiquid: [L3], ivOverrides: { [L1]: 0.3 }, spot: 3005, callVolShift: 1, putVolShift: -1, volShift: 2, start: '2026-10-21', end: '2026-10-26',
    everyNth: 2, middle: 3000, stepPct: 1, count: 20, targetDate: R2_NOV, targets: [3100],
    hypothetical: [H, { id: 's-1', instrument: 'share', expiry: 'ignored', strike: 5, optType: 'CE', qty: 10, iv: 0.3 }],
    as: 'bala',
  }
  const { as: _, ...want } = body
  assert.deepEqual(parseScenarioRequest(body), {
    ...want, hypothetical: [H, { id: 's-1', instrument: 'share', expiry: '', strike: null, optType: null, qty: 10, price: null, iv: null }],
  })
  assert.deepEqual(parseScenarioRequest({}), {})
})

// buildScenarioView over the deps it reads: the open legs, the minute snapshot, traders-trades and the end-of-day files.
const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const EOD_FIXTURES = fileURLToPath(new URL('../../../packages/span/test/fixtures/eod', import.meta.url))

async function eodStore(files: boolean): Promise<EodStore> {
  const root = mkdtempSync(join(tmpdir(), 'traders-scenario-'))
  roots.push(root)
  if (files) {
    mkdirSync(join(root, '2026-10-16'))
    copyFileSync(join(EOD_FIXTURES, 'fo-udiff.csv'), join(root, '2026-10-16', 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'))
    copyFileSync(join(EOD_FIXTURES, 'cm-udiff.csv'), join(root, '2026-10-16', 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv'))
  }
  const s = new EodStore({ dir: root, now: () => R2_NOW })
  await s.refresh()
  return s
}

async function depsOf(legs: readonly TraderLeg[], o: { files?: boolean; open?: () => Promise<readonly TraderLeg[]>; version?: () => number } = {}): Promise<TradersDeps> {
  const market = r2Market()
  const db = new TradersDb({ collection: () => ({ find: () => ({ toArray: async () => [] }) }) } as never)
  return {
    db, master: market.master, quotes: market.quotes, snapshots: new SnapshotCache(market), now: () => R2_NOW,
    legs: { open: o.open ?? (async (trader: string, stock: string) => legs.filter((l) => l.trader === trader && l.stock === stock)), version: o.version ?? (() => 0) },
    ledger: { balance: async () => null }, charges: { get: async () => SEED_RATES },
    eod: await eodStore(o.files ?? false),
  } as unknown as TradersDeps
}

// Oct 3000 CE −350 (LTP 60, yesterday's close 44) and Oct FUT +175 (LTP 3010, close 3005), both carried
const DAY_BOOK: readonly TraderLeg[] = [optLeg(R2_OCT, 3000, 'CE', -350, 47.5), r2Legs()[3] as TraderLeg]

test('buildScenarioView: the day base from yesterday’s close when the files are there, net price when not', async () => {
  const withFiles = view((await buildScenarioView(await depsOf(DAY_BOOK, { files: true }), 'asha', 'TCS', {}, R2_NOW))!)
  assert.equal(withFiles.baseNote, DAY_BASE_NOTE)
  // at CMP and now each leg is worth about its LTP: −350 × (60 − 44) + 175 × (3010 − 3005) = −5600 + 875 = −4725, the Gross MTM total
  close(withFiles.totals.pnl, -4725, 0.01)
  const none = view((await buildScenarioView(await depsOf(DAY_BOOK), 'asha', 'TCS', {}, R2_NOW))!)
  assert.equal(none.baseNote, NET_BASE_NOTE)
  close(none.totals.pnl, -350 * (60 - 47.5) + 175 * 10, 0.01)
  assert.deepEqual([withFiles.chart, withFiles.table], [none.chart, none.table])
  assert.equal(await buildScenarioView(await depsOf(DAY_BOOK), 'bala', 'TCS', {}, R2_NOW), null)
  assert.equal(await buildScenarioView(await depsOf([{ ...DAY_BOOK[1]!, expiry: '2026-09-29' }]), 'asha', 'TCS', {}, R2_NOW), null)
})

test('buildScenarioView: a hypothetical in a month nobody holds is valued on that month, and is never kept', async () => {
  const d = await depsOf(r2Legs())
  const dec: HypotheticalLeg = { id: 'd1', instrument: 'option', expiry: R2_DEC, strike: 3000, optType: 'CE', qty: 175, price: null, iv: 0.25 }
  const refused: HypotheticalLeg = { ...dec, id: 'd2', strike: 3050 }
  const base = view((await buildScenarioView(d, 'asha', 'TCS', {}, R2_NOW))!)
  const v = view((await buildScenarioView(d, 'asha', 'TCS', { hypothetical: [refused, dec] }, R2_NOW))!)
  assert.deepEqual(v.hypothetical.map((h) => [h.id, h.accepted, h.reason]), [['d2', false, 'TCS 2026-12-29 3050 CE is not listed'], ['d1', true, null]])
  assert.deepEqual(v.legs.map((l) => l.id), [...base.legs.map((l) => l.id), 'd1'])
  // Dec priced off its own forward (spot carried), not off spot, and its rate is the model there: no P&L at CMP and now
  const fwd = chainIvs(d, 'TCS', R2_DEC, R2_NOW)!.forward!
  close(v.legs.at(-1)!.underlying, fwd, 1e-9)
  assert.ok(!v.warnings.includes(`no future for ${R2_DEC}: its legs price off spot`), JSON.stringify(v.warnings))
  assert.ok(v.warnings.includes(`${R2_DEC} is valued off spot carried to expiry — no future and no two-sided quote at the money`), JSON.stringify(v.warnings))
  close(v.totals.pnl, base.totals.pnl, 1e-6)
  assert.equal(v.lastExpiry, R2_DEC)
  // the shared minute snapshot is not touched
  assert.equal(R2_DEC in d.snapshots.get('asha', 'TCS', r2Legs(), 0).chains, false)
})

test('buildScenarioView: an unquoted hypothetical future in a month nobody holds has no P&L at CMP and now (Ruling, fix round 1)', async () => {
  // the reviewer's case: +1750 Dec FUT, Dec unquoted — it entered at the carry forward and was priced off spot (−67,018)
  const d = await depsOf(r2Legs())
  const dec: HypotheticalLeg = { id: 'f1', instrument: 'future', expiry: R2_DEC, strike: null, optType: null, qty: 1750, price: null, iv: null }
  const base = view((await buildScenarioView(d, 'asha', 'TCS', {}, R2_NOW))!)
  const v = view((await buildScenarioView(d, 'asha', 'TCS', { hypothetical: [dec] }, R2_NOW))!)
  const fwd = chainIvs(d, 'TCS', R2_DEC, R2_NOW)!.forward!
  assert.deepEqual([v.hypothetical[0]!.accepted, v.hypothetical[0]!.entry], [true, fwd])
  close(v.legs.at(-1)!.underlying, fwd, 1e-9)
  close(v.totals.pnl, base.totals.pnl, 1e-6)
  assert.ok(!v.warnings.includes(`no future for ${R2_DEC}: its legs price off spot`), JSON.stringify(v.warnings))
  // a 1 % move: the future moves with the forward, × 1.01
  const up = view((await buildScenarioView(d, 'asha', 'TCS', { spot: 3030, hypothetical: [dec] }, R2_NOW))!)
  const upBase = view((await buildScenarioView(d, 'asha', 'TCS', { spot: 3030 }, R2_NOW))!)
  close(up.totals.pnl - upBase.totals.pnl, 1750 * fwd * 0.01, 1e-6)
})

test('buildScenarioView: a refused hypothetical leaves no warning for the month only it named (fix round 1)', async () => {
  const d = await depsOf(r2Legs())
  const carry = `${R2_DEC} is valued off spot carried to expiry — no future and no two-sided quote at the money`
  const unlisted: HypotheticalLeg = { id: 'd2', instrument: 'option', expiry: R2_DEC, strike: 3050, optType: 'CE', qty: 175, price: null, iv: 0.25 }
  const noIv: HypotheticalLeg = { ...unlisted, id: 'd3', strike: 3000, iv: null }
  const v = view((await buildScenarioView(d, 'asha', 'TCS', { hypothetical: [unlisted, noIv] }, R2_NOW))!)
  assert.deepEqual(v.hypothetical.map((h) => h.accepted), [false, false])
  assert.ok(!v.warnings.includes(carry), JSON.stringify(v.warnings))
  assert.deepEqual(v.warnings, view((await buildScenarioView(d, 'asha', 'TCS', {}, R2_NOW))!).warnings)
  // one accepted row in that month brings its warning
  const ok = view((await buildScenarioView(d, 'asha', 'TCS', { hypothetical: [unlisted, { ...noIv, iv: 0.25 }] }, R2_NOW))!)
  assert.ok(ok.warnings.includes(carry), JSON.stringify(ok.warnings))
})

/**
 * A leg write that lands while `open()` is reading: the version must be read BEFORE the legs, as
 * Analysis, Margin and the MTM block read it, so the old legs are never cached under the new version.
 */
test('buildScenarioView: a leg write during the read never caches the old legs under the new version', async () => {
  const before = r2Legs(), later: readonly TraderLeg[] = [futLeg(-1750)]
  let version = 0
  let writes = 1
  const d = await depsOf([], {
    open: async () => { if (writes > 0) { writes--; version++; return before } return later },
    version: () => version,
  })
  assert.notEqual(await buildScenarioView(d, 'asha', 'TCS', {}, R2_NOW), null)
  assert.deepEqual(d.snapshots.get('asha', 'TCS', later, version).legs.map((l) => l.leg.key), [later[0]!.key])
})

test('hypothetical legs are refused, never thrown on, when they reach the resolver unparsed', () => {
  const junk = [{ ...H, qty: 0 }, { ...H, price: -1 }, { ...H, iv: -0.1 }, { ...H, strike: null }] as HypotheticalLeg[]
  for (const h of junk) {
    const r = resolveHypothetical(h, S, r2Market())
    assert.deepEqual([r.leg, r.view.accepted, typeof r.view.reason], [null, false, 'string'], JSON.stringify(h))
  }
  const expired = resolveHypothetical({ ...H, expiry: '2026-09-29' }, S, r2Market())
  assert.equal(expired.view.reason, 'TCS 2026-09-29 3100 PE has expired')
  const leg: PayoffLeg | null = resolveHypothetical(H, S, r2Market()).leg
  assert.ok(leg !== null)
})
