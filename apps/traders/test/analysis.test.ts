import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b76Greeks, b76Price, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE, IV_FLOOR, rawIv } from '@algomaker/payoff'
import { buildAnalysis, buildAnalysisView, expiryTab, legTimeValue, maturityLabel, parseAnalysisQuery, toNeutralize, deltaNeutral } from '../src/analytics/analysis.ts'
import { SEED_RATES } from '../src/analytics/charges.ts'
import { EodStore } from '../src/analytics/eod.ts'
import { SpanStore, bookMargin } from '../src/analytics/margin.ts'
import { mtmOf } from '../src/analytics/mtm.ts'
import { MARKET_CLOSED, SnapshotCache, priceBook, type BookSnapshot } from '../src/analytics/snapshot.ts'
import type { AnalysisLeg, AnalysisParams, AnalysisView, MtmBlock } from '../src/analytics/wire.ts'
import { TradersDb } from '../src/db.ts'
import type { TradersDeps } from '../src/deps.ts'
import { buildTradersMaster } from '../src/market/master.ts'
import type { TradersQuotes } from '../src/market/quotes.ts'
import type { TraderLeg } from '../src/types.ts'
import {
  L1, L2, L3, L4, L5, L6, R2_DEC, R2_NOV, R2_NOW, R2_OCT, TM, futLeg, optLeg, r2Legs, r2Market, r2Master, r2Quotes, shareLeg,
} from './fixtures/r2-book.ts'

function close(a: number | null | undefined, b: number, eps: number): void {
  assert.ok(typeof a === 'number' && Math.abs(a - b) <= eps, `${a} vs ${b} (eps ${eps})`)
}

/** Every number anywhere in the view is finite (a null is fine where the wire allows it). */
function allFinite(x: unknown, path = 'view'): void {
  if (typeof x === 'number') assert.ok(Number.isFinite(x), `${path} = ${x}`)
  else if (Array.isArray(x)) x.forEach((v, i) => allFinite(v, `${path}[${i}]`))
  else if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) allFinite(v, `${path}.${k}`)
}

const S = priceBook('asha', 'TCS', r2Legs(), r2Market())
const parsed = parseAnalysisQuery(new URLSearchParams(''))
if ('error' in parsed) throw new Error(parsed.error)
const P0: AnalysisParams = parsed
const COLS = { previous: null, today: 0, total: null }
const MTM: MtmBlock = {
  gross: COLS, expense: { previous: null, today: 0, total: 0 }, current: COLS, squareOff: 0, projected: null,
  payInOut: 0, cfBalance: 0, openCycleCharges: 0, dayReason: null, partial: [], ratesConfirmed: false, notes: [],
}
const A = (s: BookSnapshot, p: AnalysisParams): AnalysisView => buildAnalysis(s, p, MTM, '2026-10-21')
function row(v: AnalysisView, k: string): AnalysisLeg {
  const r = v.legs.find((l) => l.key === k)
  assert.ok(r, `no leg row ${k}`)
  return r
}
const noQuotes: TradersQuotes = { quote: () => null, feedAlive: () => true }

test('the leg table carries VolHedge v50’s columns', () => {
  const r = row(A(S, P0), L1)
  assert.deepEqual([r.type, r.maturity, r.maturityDate, r.strike, r.units, r.lots, r.ltp, r.netPrice, r.buyPrice, r.salePrice, r.grossMtm, r.syntheticFuture, r.timeValue, r.ivSource, r.remarks],
    ['C', 'Oct 26', '2026-10-27', 3000, -175, -1, 60, 50, 59.5, 60.5, -1750, 3010, 8750, 'quote', ''])   // time value 175 × (60 − 10): 10 in the money on the 3010 future
  assert.equal(r.ivUsed, r.marketIv); close(r.deltaValue, r.delta * -175, 1e-9)
  assert.equal(row(A(S, P0), L3).remarks, 'illiquid (no fresh quote) · IV from other side 3100 PE')
  assert.equal(row(A(S, P0), L5).remarks, 'manual')
})
test('an unticked leg leaves every total but keeps its row', () => {
  const a = A(S, P0), b = A(S, { ...P0, exclude: [L1] })
  assert.equal(row(b, L1).included, false); close(b.totals.T.delta, a.totals.T.delta - row(a, L1).deltaValue, 1e-9)
})
test('month tab filters legs, not the month-wise panel', () => {
  const v = A(S, { ...P0, expiry: '2026-11-23' })
  assert.deepEqual(v.legs.map((l) => l.key), [L2]); assert.deepEqual(v.monthWise.map((m) => m.label), ['27OCT', '23NOV', 'EQ'])
})
test('VolHedge’s labels', () => assert.deepEqual([maturityLabel('2026-10-27'), expiryTab('2026-10-27'), expiryTab('2026-10-20'), expiryTab('')], ['Oct 26', '27OCT', '20OCT', 'EQ']))
test('time value reproduces VolHedge’s JINDALSTEL screen (19 Oct 2026, future 1042.70)', () => {
  const rows = [[-10625, 13.8, 1060, 'CE'], [3750, 7.6, 1080, 'CE'], [7500, 4.2, 1100, 'CE'], [1875, 1.55, 940, 'PE'], [5625, 2.65, 960, 'PE'], [5000, 4.6, 980, 'PE'], [-625, 7.35, 1000, 'PE'], [-8125, 13, 1020, 'PE']] as const
  const tv = rows.map(([u, ltp, k, t]) => legTimeValue(u, ltp, k, t, 1042.7)!)
  close(tv[0]!, 146625, 1e-6); close(tv.reduce((a, b) => a + b, 0), 156031.25, 1e-6)
})
test('call vol moves T, never N; a typed IV is the base and is marked; comparison is T − N', () => {
  const v = A(S, { ...P0, callVol: 2, ivOverrides: { [L1]: 0.245 } })
  assert.deepEqual(v.totals.N, A(S, P0).totals.N)
  const r = row(v, L1); close(r.ivUsed!, 0.265, 1e-12); assert.deepEqual([r.ivSource, r.remarks], ['override', 'IV typed'])
  close(v.comparison.diff.vega, v.totals.T.vega - v.totals.N.vega, 1e-9)
})
test('a future override reprices T against it', () => {
  const v = A(S, { ...P0, future: 3040 })
  assert.deepEqual([v.future, v.futureOverridden], [3040, true]); assert.notEqual(v.totals.T.delta, v.totals.N.delta)
})
test('To Neutralize in the nearest future’s lots', () => {
  assert.deepEqual(toNeutralize(-1234, 'TCS', '2026-10-27', 175), { units: 1234, price: null, pct: null, lots: 7, side: 'Buy', contract: 'TCS OCT FUT', text: 'Buy 7 lots TCS OCT FUT' })
  assert.equal(toNeutralize(262.5, 'TCS', '2026-10-27', 175).text, 'Sell 2 lots TCS OCT FUT')
  assert.equal(toNeutralize(175, 'TCS', '2026-10-27', 175).text, 'Sell 1 lot TCS OCT FUT')
  assert.equal(toNeutralize(-420, 'JINDALSTEL', '2026-10-27', 625).units, 420)                    // VolHedge: "420.00"
  assert.deepEqual(toNeutralize(80, 'TCS', '2026-10-27', 175), { units: -80, price: null, pct: null, lots: 0, side: null, contract: 'TCS OCT FUT', text: 'Neutral — within half a lot (-80 shares)' })
})
test('1,000 shares by hand move delta by 1,000 and To Neutralize by the right lots (spec 4a)', () => {
  const fut = futLeg(-1750), share = shareLeg(1000)                          // Oct FUT −10 lots @3000; manual +1000 shares
  const a = A(priceBook('asha', 'TCS', [fut], r2Market()), P0), b = A(priceBook('asha', 'TCS', [fut, share], r2Market()), P0)
  assert.equal(b.totals.T.delta - a.totals.T.delta, 1000)
  assert.deepEqual([a.toNeutralize!.text, b.toNeutralize!.text], ['Buy 10 lots TCS OCT FUT', 'Buy 4 lots TCS OCT FUT'])
})
test('breakeven range at the near expiry', () => {
  const straddle = priceBook('asha', 'TCS', [optLeg('2026-10-27', 3000, 'CE', -175, 60), optLeg('2026-10-27', 3000, 'PE', -175, 50)], r2Market())
  assert.equal(A(straddle, P0).breakevens.text, 'BEP = 2880.4 - 3099.7')   // F = 2890 / 3110 on the Oct future, × 3000/3010 to spot
})
test('Gap Up/Down: two rows at the next open', () => {
  const g = A(priceBook('asha', 'TCS', [futLeg(-1750)], r2Market()), P0).gapPanel
  assert.deepEqual([g.on, g.rows.map((r) => [r.movePct, r.volPts])], ['2026-10-21', [[10, -10], [-10, -10]]])
  close(g.rows[0]!.price, 3300, 1e-9); close(g.rows[0]!.pnl, -544250, 1e-6); close(g.rows[0]!.change, -526750, 1e-6)   // base = −1750 × (3010 − 3000)
})
test('the vol basis moves options only', () => {
  const fut = priceBook('asha', 'TCS', [futLeg(-1750)], r2Market())
  assert.deepEqual(A(fut, { ...P0, volBasis: 'cash' }).gapPanel.rows, A(fut, P0).gapPanel.rows)
  assert.notDeepEqual(A(S, { ...P0, volBasis: 'cash' }).gapPanel.rows, A(S, P0).gapPanel.rows)
  // an unquoted future too (Task 12 ruling, fix round 2): its own price is the month's FUTURE-basis forward on every basis
  const unq = priceBook('asha', 'TCS', [futLeg(-1750)], r2Market({ quotes: { 10: null } }))
  const onFuture = A(unq, P0).gapPanel.rows
  for (const volBasis of ['cash', 'synthetic'] as const) assert.deepEqual(A(unq, { ...P0, volBasis }).gapPanel.rows, onFuture, volBasis)
  close(onFuture[0]!.pnl - onFuture[0]!.change, -1750 * (unq.optionFutures[R2_OCT]! - 3000), 1e-6)   // the base, on the forward
})
test('an unquoted held future is valued at its month’s forward, not spot (Task 12 ruling, fix round 1)', () => {
  // the Oct future unquoted: its month's forward is parity at the 3000 strike (CE 60 − PE 50), and the future prices there too
  const s = priceBook('asha', 'TCS', [futLeg(-1750)], r2Market({ quotes: { 10: null } }))
  const fwd = s.optionFutures[R2_OCT]!
  assert.ok(s.futures[R2_OCT] === null && fwd > 3005 && fwd < 3015, String(fwd))
  const v = A(s, P0)
  // no LTP: the gap base is the model at spot, −1750 × (fwd − 3000); the +10 % row is on fwd × 1.1 (it was 3000 and 3300, off spot)
  close(v.gapPanel.rows[0]!.pnl, -1750 * (fwd * 1.1 - 3000), 1e-6)
  close(v.gapPanel.rows[0]!.pnl - v.gapPanel.rows[0]!.change, -1750 * (fwd - 3000), 1e-6)
  // the short future breaks even where its forward is 3000: spot 3000 × 3000 / fwd (it was 3000, off spot)
  close(v.breakevens.low, (3000 * 3000) / fwd, 1e-6); assert.equal(v.breakevens.high, null)
})
test('a held future with no quote, valued at its forward, says so once per month (Task 12 ruling, fix round 2)', () => {
  const note = '27 Oct future unquoted — valued at its forward'
  const two = priceBook('asha', 'TCS', [futLeg(-1750), r2Legs()[3]!], r2Market({ quotes: { 10: null } }))   // two Oct futures, clients C2 and C1
  assert.deepEqual(A(two, P0).warnings.filter((w) => w === note), [note])
  // not when quoted, not when every future of the month is unticked, not for a month that holds only options (Nov, its future unquoted)
  assert.ok(!A(priceBook('asha', 'TCS', [futLeg(-1750)], r2Market()), P0).warnings.includes(note))
  assert.ok(!A(two, { ...P0, exclude: two.legs.map((l) => l.leg.key) }).warnings.includes(note))
  const nov = A(priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { 11: null } })), P0)
  assert.ok(!nov.warnings.some((w) => w.includes('future unquoted')), JSON.stringify(nov.warnings))
})
test('unknown keys are ignored (Review Focus 3)', () =>
  assert.deepEqual(A(S, { ...P0, exclude: ['bala|option|TCS|2026-10-27|3000|CE'], illiquid: ['nope'], ivOverrides: { nope: 0.5 } }).totals, A(S, P0).totals))
test('query parsing', () => {
  assert.deepEqual(parseAnalysisQuery(new URLSearchParams('exclude=a&exclude=b&iv=manual%3Ax1%400.245&callVol=2&gap=5,0&gap=-5,2&gapLtp=0&basis=synthetic')),
    { expiry: null, exclude: ['a', 'b'], illiquid: [], ivOverrides: { 'manual:x1': 0.245 }, callVol: 2, putVol: 0, future: null,
      gap: [{ movePct: 5, volPts: 0 }, { movePct: -5, volPts: 2 }], gapUseLtp: false, gapUseVol: true, volBasis: 'synthetic' })
  for (const bad of ['iv=k@0', 'callVol=x', 'expiry=OCT', 'future=-1', 'putVol=51', 'gap=5,0', 'gap=60,0&gap=1,1', 'basis=spot', 'gapVol=yes'])
    assert.ok('error' in parseAnalysisQuery(new URLSearchParams(bad)), bad)
})

// ---- beyond the brief's list ----

test('the defaults, and every error names its parameter', () => {
  assert.deepEqual(P0, {
    expiry: null, exclude: [], illiquid: [], ivOverrides: {}, callVol: 0, putVol: 0, future: null,
    gap: [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }], gapUseLtp: true, gapUseVol: true, volBasis: 'future',
  })
  const cases: readonly [string, string][] = [
    ['iv=k@0', 'iv'], ['iv=k@5.01', 'iv'], ['iv=@0.2', 'iv'], ['iv=k', 'iv'], ['iv=k@abc', 'iv'], ['callVol=x', 'callVol'], ['callVol=', 'callVol'],
    ['callVol=0x10', 'callVol'], ['putVol=-50.5', 'putVol'], ['expiry=2026-02-30', 'expiry'], ['future=0', 'future'], ['future=Infinity', 'future'],
    ['gap=5,0', 'gap'], ['gap=1,2,3&gap=1,1', 'gap'], ['gap=1&gap=1,1', 'gap'], ['gap=1,1&gap=1,1&gap=1,1', 'gap'], ['gap=1,51&gap=1,1', 'gap'],
    ['gapLtp=true', 'gapLtp'], ['gapVol=yes', 'gapVol'], ['basis=spot', 'basis'],
    [Array.from({ length: 101 }, (_, i) => `exclude=k${i}`).join('&'), 'exclude'],
    [Array.from({ length: 101 }, (_, i) => `illiquid=k${i}`).join('&'), 'illiquid'],
  ]
  for (const [q, name] of cases) {
    const r = parseAnalysisQuery(new URLSearchParams(q))
    assert.ok('error' in r && r.error.startsWith(name), `${q.slice(0, 40)} → ${JSON.stringify(r)}`)
  }
  // the key may hold an '@': the IV is after the LAST one; ?as= is the route's, not the parser's
  const ok = parseAnalysisQuery(new URLSearchParams('iv=a%40b%400.3&as=asha&callVol=-50&putVol=1e1&future=3040.5&gapVol=0&gapLtp=1&basis=cash&expiry=2026-11-23'))
  assert.ok(!('error' in ok))
  assert.deepEqual([ok.ivOverrides, ok.callVol, ok.putVol, ok.future, ok.gapUseVol, ok.gapUseLtp, ok.volBasis, ok.expiry],
    [{ 'a@b': 0.3 }, -50, 10, 3040.5, false, true, 'cash', '2026-11-23'])
  const many = parseAnalysisQuery(new URLSearchParams(Array.from({ length: 100 }, (_, i) => `exclude=k${i}`).join('&')))
  assert.ok(!('error' in many) && many.exclude.length === 100)
})

test('the view’s header: months, near expiry and future, days, lot size, the fixed notes', () => {
  const v = A(S, P0)
  assert.deepEqual(v.months, [{ expiry: R2_OCT, label: '27OCT' }, { expiry: R2_NOV, label: '23NOV' }])
  assert.deepEqual([v.stock, v.asOf, v.closed, v.spot, v.future, v.futureOverridden, v.nearExpiry, v.daysToExpiry, v.nearFuture, v.lotSize, v.lotGcd],
    ['TCS', R2_NOW, false, 3000, 3010, false, R2_OCT, 8, R2_OCT, 175, 1])   // 1000 shares are not whole lots of 175
  assert.deepEqual(v.legs.map((l) => l.key), [L1, L2, L3, L4, L5])
  assert.equal(v.unmatched.length, 1)
  assert.equal(v.totals.note, 'T = at IV used · N = at market IV — our reading of VolHedge (Phase 0 Q3)')
  assert.equal(v.comparison.note, "diff = T - N — our reading of VolHedge's Greeks Comparison (Phase 0 Q3)")
  assert.equal(v.gapPanel.note, "At the next open, 09:15 IST 21 Oct — our reading of VolHedge's Gap Up/Down (Phase 0 Q3)")
  assert.deepEqual([v.gapPanel.basis, v.gapPanel.useLtp, v.gapPanel.useVol], ['future', true, true])
  assert.equal(v.mtm, MTM)
  assert.deepEqual(v.warnings, S.warnings)
})

test('the other rows: a future, a share, a far-month option', () => {
  const v = A(S, P0)
  const f = row(v, L4), sh = row(v, L5), nov = row(v, L2)
  assert.deepEqual([f.type, f.maturity, f.strike, f.units, f.lots, f.ltp, f.grossMtm, f.timeValue, f.ivUsed, f.marketIv, f.delta, f.deltaValue, f.vega, f.ivSource, f.illiquid],
    ['F', 'Oct 26', null, 175, 1, 3010, 1750, null, null, null, 1, 175, 0, 'none', false])
  assert.deepEqual([sh.type, sh.maturity, sh.maturityDate, sh.units, sh.ltp, sh.netPrice, sh.grossMtm, sh.delta, sh.deltaValue, sh.source],
    ['EQ', 'EQ', '', 1000, 3000, 2950, 50000, 1, 1000, 'manual'])
  // Nov 3000 CE +175 @80, LTP 95 on the 3030 Nov future: time value −175 × (95 − 30)
  assert.deepEqual([nov.maturity, nov.maturityDate, nov.timeValue, nov.grossMtm], ['Nov 26', R2_NOV, -11375, 2625])
  // the book's time value over the options: 8750 − 11375 + 175 × 30 (the 3100 CE is out of the money)
  assert.equal(v.bookTimeValue, 2625)
})

test('totals, month-wise, option greeks and To Neutralize add the right legs', () => {
  const v = A(S, P0)
  const sum = (keys: readonly string[], k: 'deltaValue' | 'vegaValue') => keys.reduce((a, key) => a + row(v, key)[k], 0)
  close(v.totals.T.delta, sum([L1, L2, L3, L4, L5], 'deltaValue'), 1e-9)
  assert.deepEqual(v.monthWise.map((m) => m.expiry), [R2_OCT, R2_NOV, ''])
  close(v.monthWise[0]!.totals.delta, sum([L1, L3, L4], 'deltaValue'), 1e-9)
  close(v.monthWise[1]!.totals.vega, row(v, L2).vegaValue, 1e-9)
  assert.equal(v.monthWise[2]!.totals.delta, 1000)
  close(v.optionGreeks.delta, sum([L1, L2, L3], 'deltaValue'), 1e-9)
  assert.deepEqual(v.comparison.T, v.totals.T); assert.deepEqual(v.comparison.N, v.totals.N)
  assert.equal(v.toNeutralize!.units, -Math.round(v.totals.T.delta))
  // a month tab narrows the totals, the option greeks and the time value, never To Neutralize or month-wise
  const nov = A(S, { ...P0, expiry: R2_NOV })
  close(nov.totals.T.delta, row(v, L2).deltaValue, 1e-9)
  close(nov.optionGreeks.delta, row(v, L2).deltaValue, 1e-9); close(nov.optionGreeks.vega, row(v, L2).vegaValue, 1e-9)
  assert.equal(nov.bookTimeValue, -11375)
  assert.deepEqual([nov.toNeutralize, nov.monthWise], [v.toNeutralize, v.monthWise])
  // Oct's option greeks are its two calls, not its future
  close(A(S, { ...P0, expiry: R2_OCT }).optionGreeks.delta, sum([L1, L3], 'deltaValue'), 1e-9)
  // an excluded leg leaves the whole book's figures too
  const ex = A(S, { ...P0, exclude: [L5] })
  assert.equal(ex.monthWise[2]!.totals.delta, 0)
  assert.equal(ex.toNeutralize!.units, v.toNeutralize!.units + 1000)
})

test('a tick prices the leg off the other side, is remarked, and reaches the gap panel on any basis', () => {
  const v = A(S, { ...P0, illiquid: [L1] })
  const r = row(v, L1)
  assert.deepEqual([r.illiquid, r.illiquidAuto, r.ivSource, r.ivFrom, r.remarks],
    [true, false, 'other-side', { strike: 3000, optType: 'PE' }, 'illiquid (ticked) · IV from other side 3000 PE'])
  assert.notEqual(r.marketIv, row(A(S, P0), L1).marketIv)
  assert.deepEqual([row(v, L3).illiquid, row(v, L3).illiquidAuto], [true, true])
  for (const volBasis of ['future', 'cash', 'synthetic'] as const) {
    assert.notDeepEqual(A(S, { ...P0, volBasis, illiquid: [L1] }).gapPanel.rows, A(S, { ...P0, volBasis }).gapPanel.rows, volBasis)
  }
  // a tick on a future or a share is not a thing: it is ignored like an unknown key
  assert.deepEqual(A(S, { ...P0, illiquid: [L4, L5] }), A(S, P0))
})

test('unknown keys leave the whole answer as the no-params one, params included', () => {
  const v = A(S, { ...P0, exclude: ['bala|option|TCS|2026-10-27|3000|CE', 'nope'], illiquid: ['nope'], ivOverrides: { nope: 0.5, [L4]: 0.3 } })
  assert.deepEqual(v, A(S, P0))
  // a typed IV on a known option is kept, and a repeated exclude counts once
  const w = A(S, { ...P0, exclude: [L1, L1], ivOverrides: { [L1]: 0.3, nope: 0.5 } })
  assert.deepEqual([w.params.exclude, w.params.ivOverrides], [[L1], { [L1]: 0.3 }])
})

test('the gap base: current MTM at LTP, or the model at spot when Ltp is off', () => {
  const book = priceBook('asha', 'TCS', [optLeg(R2_OCT, 3000, 'CE', -175, 50)], r2Market())
  const p = { ...P0, ivOverrides: { [L1]: 0.5 } }
  const ltp = A(book, p).gapPanel.rows, model = A(book, { ...p, gapUseLtp: false }).gapPanel.rows
  assert.deepEqual(ltp.map((r) => r.pnl), model.map((r) => r.pnl))
  close(ltp[0]!.pnl - ltp[0]!.change, -175 * (60 - 50), 1e-9)
  const at = b76Price({ future: 3010, strike: 3000, t: yearsToExpiry(R2_OCT, R2_NOW), vol: 0.5, rate: DEFAULT_RATE, type: 'CE' })
  close(model[0]!.pnl - model[0]!.change, -175 * (at - 50), 1e-6)
  assert.equal(A(book, { ...p, gapUseLtp: false }).gapPanel.useLtp, false)
  // Vol off: the rows keep today's vols
  const flat = A(book, { ...p, gapUseVol: false }).gapPanel.rows
  assert.notEqual(flat[0]!.pnl, ltp[0]!.pnl)
})

test('an option with no IV marks flat: remarked, warned, its greeks 0 and its IVs null', () => {
  const dec = optLeg(R2_DEC, 3000, 'CE', -175, 40)
  const v = A(priceBook('asha', 'TCS', [dec, futLeg(175)], r2Market()), P0)
  const r = row(v, dec.key)
  assert.deepEqual([r.ivUsed, r.marketIv, r.ivSource, r.delta, r.vegaValue, r.ltp, r.grossMtm, r.timeValue],
    [null, null, 'none', 0, 0, null, null, null])
  assert.equal(r.remarks, 'illiquid (no fresh quote) · no IV — marks flat')
  assert.ok(v.warnings.includes('TCS 3000 CE 2026-12-29 (client C1): no IV — marks flat'), JSON.stringify(v.warnings))
  assert.equal(v.totals.T.delta, 175)
  // a typed IV prices it again
  const typed = row(A(priceBook('asha', 'TCS', [dec], r2Market()), { ...P0, ivOverrides: { [dec.key]: 0.25 } }), dec.key)
  assert.deepEqual([typed.ivUsed, typed.ivSource, typed.remarks], [0.25, 'override', 'illiquid (no fresh quote) · IV typed'])
  assert.notEqual(typed.delta, 0)
})

test('a vol shift below zero is floored, and the view says so', () => {
  const v = A(S, { ...P0, callVol: -50 })
  assert.equal(row(v, L1).ivUsed, IV_FLOOR)
  // the payoff package's own shift rule and floor, not a copy of them
  const raw = rawIv(S.legs.find((l) => l.leg.key === L1)!.payoff, { callVolShift: -50 })!
  assert.ok(raw < IV_FLOOR)
  assert.ok(v.warnings.includes(`TCS 3000 CE 2026-10-27 (client C1): IV ${raw.toFixed(4)} after the vol shift, floored at 0.0001`), JSON.stringify(v.warnings))
})

test('a future override with no price for the near future is not applied, and says so', () => {
  const s = priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { 10: null } }))
  const v = A(s, { ...P0, future: 3040 })
  assert.deepEqual([v.future, v.futureOverridden], [null, false])
  assert.ok(v.warnings.includes('Future override 3040 not applied — no price for TCS OCT FUT'), JSON.stringify(v.warnings))
  assert.deepEqual(v.totals.T, A(s, P0).totals.T)
  assert.notEqual(v.toNeutralize, null)   // To Neutralize needs the delta and the lot, not the future's price
})

test('with no listed future: future —, To Neutralize null, and the view says why', () => {
  const m = buildTradersMaster(r2Master().filter((r) => r.instrument_type !== 'FUT'), 0)
  const s = priceBook('asha', 'TCS', [optLeg(R2_OCT, 3000, 'CE', -175, 50)], { master: () => m, quotes: r2Quotes(), now: () => R2_NOW })
  const v = A(s, { ...P0, future: 3040 })
  assert.deepEqual([v.future, v.futureOverridden, v.nearFuture, v.toNeutralize], [null, false, null, null])
  assert.ok(v.warnings.includes('TCS lists no future — To Neutralize is not worked out'), JSON.stringify(v.warnings))
  assert.ok(v.warnings.includes('Future override 3040 not applied — TCS lists no future'), JSON.stringify(v.warnings))
})

test('no spot price: nothing is valued, one warning says so, and no number is NaN', () => {
  const s = priceBook('asha', 'TCS', r2Legs(), { master: () => TM, quotes: noQuotes, now: () => R2_NOW })
  const v = A(s, P0)
  assert.ok(v.warnings.includes('no spot price for TCS — the book is not valued: greeks 0, no breakevens, no gap rows'), JSON.stringify(v.warnings))
  assert.deepEqual([v.spot, v.future, v.toNeutralize, v.breakevens, v.gapPanel.rows], [null, null, null, { low: null, high: null, expiry: R2_OCT, text: 'BEP = — - —' }, []])
  assert.deepEqual(v.totals.T, { delta: 0, gamma: 0, vega: 0, theta: 0, vanna: 0, volga: 0 })
  assert.equal(row(v, L4).remarks, 'cannot be priced')
  assert.equal(row(v, L5).remarks, 'manual · cannot be priced')
  allFinite(v)
})

test('the future override scales every month: Oct to 3040, Nov by 3040/3010 (T only)', () => {
  const t = (expiry: string) => yearsToExpiry(expiry, R2_NOW)
  const g = (expiry: string, future: number, vol: number) => b76Greeks({ future, strike: 3000, t: t(expiry), vol, rate: DEFAULT_RATE, type: 'CE' })
  const v = A(S, { ...P0, future: 3040 })
  const oct = row(v, L1), nov = row(v, L2)
  const atOct = g(R2_OCT, 3040, oct.ivUsed!), atNov = g(R2_NOV, (3030 * 3040) / 3010, nov.ivUsed!)
  close(oct.delta, atOct.delta, 1e-9); close(oct.vega, atOct.vega, 1e-9); close(oct.gamma, atOct.gamma, 1e-12)
  close(nov.delta, atNov.delta, 1e-9); close(nov.vega, atNov.vega, 1e-9)
  // N stays on the market futures, 3010 and 3030
  const n = A(S, P0)
  close(row(n, L1).delta, g(R2_OCT, 3010, row(n, L1).marketIv!).delta, 1e-9)
  assert.deepEqual(v.totals.N, n.totals.N)
  close(v.totals.T.delta, [L1, L2, L3, L4, L5].reduce((a, k) => a + row(v, k).deltaValue, 0), 1e-9)
})

/** The pinned book with every lot of the Oct future (and, with `all`, of every row) set to `lot`. */
function lotBook(lot: number, all = false): BookSnapshot {
  const rows = r2Master().map((r) => (all || (r.instrument_type === 'FUT' && r.expiry === R2_OCT) ? { ...r, lot_size: lot } : r))
  const m = buildTradersMaster(rows, 0)
  return priceBook('asha', 'TCS', [futLeg(-1750)], { master: () => m, quotes: r2Quotes(), now: () => R2_NOW })
}

test('To Neutralize rounds to the nearest future’s own lot; a lot of 0 falls back to the chain’s, then to none', () => {
  const own = A(lotBook(350), P0)
  assert.equal(lotBook(350).nearFuture!.lotSize, 350)
  assert.deepEqual([own.lotSize, own.toNeutralize!.lots, own.toNeutralize!.text], [175, 5, 'Buy 5 lots TCS OCT FUT'])   // 1750 / 350, not / 175
  const zeroFut = A(lotBook(0), P0)
  assert.equal(lotBook(0).nearFuture!.lotSize, null)
  assert.equal(zeroFut.toNeutralize!.text, 'Buy 10 lots TCS OCT FUT')                                                  // the chain's 175
  const none = A(lotBook(0, true), P0)
  assert.deepEqual([none.lotSize, none.toNeutralize], [null, null])
  assert.ok(none.warnings.includes('no lot size for TCS OCT FUT — To Neutralize is not worked out'), JSON.stringify(none.warnings))
  allFinite(none)
})

test('toNeutralize is total: a lot that is not a positive number gives no lots and says so, never NaN', () => {
  for (const lot of [0, -175, Number.NaN, Number.POSITIVE_INFINITY]) {
    const t = toNeutralize(-1234, 'TCS', R2_OCT, lot)
    allFinite(t)
    assert.deepEqual(t, { units: 1234, price: null, pct: null, lots: 0, side: null, contract: 'TCS OCT FUT', text: 'Delta -1234 — lot size unknown, cannot size TCS OCT FUT' }, String(lot))
  }
  assert.equal(toNeutralize(420, 'TCS', R2_OCT, 0).text, 'Delta +420 — lot size unknown, cannot size TCS OCT FUT')
  assert.equal(toNeutralize(419.6, 'TCS', R2_OCT, Number.NaN).text, 'Delta +420 — lot size unknown, cannot size TCS OCT FUT')
  assert.equal(toNeutralize(0.2, 'TCS', R2_OCT, 0).text, 'Neutral (0 shares)')
  assert.deepEqual(toNeutralize(Number.NaN, 'TCS', R2_OCT, 175), { units: 0, price: null, pct: null, lots: 0, side: null, contract: 'TCS OCT FUT', text: 'Neutral — within half a lot (0 shares)' })
})

/**
 * A leg write that lands while `open()` is reading: the read returns the legs as they were, the
 * version is already the next one. Every reader of the minute snapshot must take the version
 * BEFORE the read, so the old legs are never cached under the new version.
 */
test('a leg write during the read never caches the old legs under the new version (analysis, margin, MTM)', async () => {
  const before = r2Legs(), after: readonly TraderLeg[] = [futLeg(-1750)]
  const readers: [string, (d: TradersDeps) => Promise<unknown>][] = [
    ['analysis', (d) => buildAnalysisView(d, 'asha', 'TCS', P0, R2_NOW)],
    ['margin', (d) => bookMargin(d, 'asha', 'TCS', R2_NOW)],
    ['mtm', (d) => mtmOf(d, 'asha', 'TCS', R2_NOW)],
  ]
  for (const [name, read] of readers) {
    let version = 0
    let writes = 1
    const snapshots = new SnapshotCache(r2Market())
    const db = new TradersDb({ collection: () => ({ find: () => ({ toArray: async () => [] }) }) } as never)
    const d = {
      db, master: () => TM, quotes: r2Quotes(), snapshots, now: () => R2_NOW,
      legs: {
        open: async () => { if (writes > 0) { writes--; version++; return before } return after },
        version: () => version,
      },
      ledger: { balance: async () => null }, charges: { get: async () => SEED_RATES },
      eod: new EodStore({ dir: join(tmpdir(), 'algomaker-traders-test-no-nse'), now: () => R2_NOW }),
      span: new SpanStore({ dir: join(tmpdir(), 'algomaker-traders-test-no-nse'), now: () => R2_NOW }),
    } as unknown as TradersDeps
    assert.notEqual(await read(d), null, name)
    // the next read is at the new version: it must price the new legs, not find the old ones cached there
    assert.deepEqual(snapshots.get('asha', 'TCS', after, version).legs.map((l) => l.leg.key), [after[0]!.key], name)
  }
})

/** What buildAnalysisView reads, at `now`: asha's pinned book, no trades, no NSE files. */
function viewDeps(now: number): TradersDeps {
  const nse = join(tmpdir(), 'algomaker-traders-test-no-nse')
  return {
    db: new TradersDb({ collection: () => ({ find: () => ({ toArray: async () => [] }) }) } as never),
    master: () => TM, quotes: r2Quotes({}, { now }), snapshots: new SnapshotCache(r2Market({ now })), now: () => now,
    legs: { open: async () => r2Legs(), version: () => 0 },
    ledger: { balance: async () => null }, charges: { get: async () => SEED_RATES },
    eod: new EodStore({ dir: nse, now: () => now }), span: new SpanStore({ dir: nse, now: () => now }),
  } as unknown as TradersDeps
}

test('the gap panel before 09:15 on a trading day is this morning\'s open, not tomorrow\'s (final fix I1)', async () => {
  const at = (iso: string): number => Date.parse(`${iso}+05:30`)
  const gap = async (now: number) => (await buildAnalysisView(viewDeps(now), 'asha', 'TCS', P0, now))!.gapPanel
  const expiryMorning = await gap(at('2026-10-27T08:45:00'))      // the Oct legs expire today: at 09:15 they still have the day
  assert.equal(expiryMorning.on, '2026-10-27')
  assert.equal(expiryMorning.note, "At the next open, 09:15 IST 27 Oct — our reading of VolHedge's Gap Up/Down (Phase 0 Q3)")
  assert.equal((await gap(at('2026-10-27T10:00:00'))).on, '2026-10-28')
  assert.equal((await gap(at('2026-10-20T08:45:00'))).on, '2026-10-21')      // a holiday morning
})

test('a closed market is said once: the view\'s closed flag, never a warning beside it (final fix M5)', () => {
  const evening = priceBook('asha', 'TCS', r2Legs(), r2Market({ now: Date.UTC(2026, 9, 19, 11, 0) }))   // 16:30 IST
  assert.ok(evening.warnings.includes(MARKET_CLOSED))
  const v = A(evening, P0)
  assert.equal(v.closed, true)
  assert.equal(v.warnings.includes(MARKET_CLOSED), false)
  for (const volBasis of ['cash', 'synthetic'] as const) assert.equal(A(evening, { ...P0, volBasis }).warnings.includes(MARKET_CLOSED), false, volBasis)
})

test('every number in the view is finite or null', () => {
  const books: BookSnapshot[] = [
    S,
    lotBook(0, true),
    priceBook('asha', 'TCS', r2Legs(), { master: () => TM, quotes: noQuotes, now: () => R2_NOW }),
    priceBook('asha', 'TCS', [optLeg(R2_DEC, 3000, 'CE', -175, 40), futLeg(175)], r2Market()),
    priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { 10: null, 11: null } })),
    priceBook('asha', 'TCS', r2Legs(), r2Market({ now: Date.UTC(2026, 9, 19, 12, 0) })),   // 17:30 IST: closed
  ]
  const params: AnalysisParams[] = [
    P0,
    { ...P0, callVol: 50, putVol: -50, future: 3040, ivOverrides: { [L1]: 5, [L3]: 0.0001 }, gapUseLtp: false },
    { ...P0, gap: [{ movePct: 50, volPts: 50 }, { movePct: -50, volPts: -50 }], volBasis: 'cash' },
    { ...P0, volBasis: 'synthetic', illiquid: [L1, L2, L3], gapUseVol: false },
    { ...P0, expiry: R2_NOV, exclude: [L1, L2, L3, L4, L5] },
    { ...P0, expiry: '2027-01-28' },
  ]
  for (const s of books) for (const p of params) allFinite(A(s, p))
})

test('Δ0 is spot − Δ/Γ with its distance from spot, as the desk works it out; null without spot or gamma', () => {
  assert.deepEqual(deltaNeutral(1000, -500, 10), { price: 1050, pct: 5 })      // short delta, long gamma: neutral above spot
  assert.deepEqual(deltaNeutral(1000, -500, -10), { price: 950, pct: -5 })     // short gamma: the other side
  for (const [spot, d, g] of [[null, -500, 10], [0, -500, 10], [1000, -500, 0], [1000, Number.NaN, 10], [1000, -500, Number.NaN]] as const) {
    assert.deepEqual(deltaNeutral(spot, d, g), { price: null, pct: null }, String([spot, d, g]))
  }
})

test('the analysis carries the whole book\'s series whatever the month tab, open at the leg table\'s GrossMTM', async () => {
  const closed = (side: 'Buy' | 'Sell', price: number, day: string, seq: number) => ({
    clientCode: 'C0001', stock: 'TCS', instrument: 'option' as const, expiry: R2_OCT, strike: 2900, optType: 'PE' as const,
    side, qty: 175, price, day, time: Date.parse(`${day}T10:00:00+05:30`), seq, orderNo: `o${seq}`,
  })
  const base = { trades: [closed('Sell', 12, '2026-10-12', 1), closed('Buy', 7, '2026-10-13', 2)], balance: null, historyFrom: '2026-09-01', rates: SEED_RATES }
  const d = { ...viewDeps(R2_NOW), series: async () => base } as unknown as TradersDeps
  const whole = (await buildAnalysisView(d, 'asha', 'TCS', P0, R2_NOW))!
  const nov = (await buildAnalysisView(d, 'asha', 'TCS', { ...P0, expiry: R2_NOV }, R2_NOW))!
  assert.deepEqual(nov.series, whole.series)
  const gross = (e: string) => whole.legs.filter((l) => l.maturityDate === e).reduce((s, l) => s + (l.grossMtm as number), 0)
  assert.deepEqual(whole.series?.map((s) => [s.expiry, s.booked, s.closedContracts]), [[R2_OCT, 875, 1], [R2_NOV, 0, 0]])
  // the pinned book's 3050 CE is not a listed strike: out of the leg table, so no GrossMTM, and the Oct series names it
  assert.deepEqual([whole.legs.some((l) => l.key === L6), whole.unmatched.length], [false, 1])
  assert.deepEqual([whole.series?.[0]?.noLtp, whole.series?.[0]?.open, whole.series?.[0]?.net, whole.seriesTotal?.net], [[L6], null, null, null])
  assert.ok(whole.series?.[0]?.notes.includes('3050 CE 2026-10-27: no LTP — open and net unknown'))
  close(whole.series?.[1]?.open, gross(R2_NOV), 1e-6)
  assert.deepEqual(whole.seriesTotal?.notes, ['shares are left out of P&L: they have no expiry'])
  assert.equal('series' in (await buildAnalysisView(viewDeps(R2_NOW), 'asha', 'TCS', P0, R2_NOW))!, false)
})
