import { test } from 'node:test'
import assert from 'node:assert/strict'
import { yearsToExpiry } from '@algomaker/greeks'
import { INDEX_SPOT_TOKENS } from '@algomaker/instruments'
import { lastClosedSession, marketContextOf, type ContextDeps } from '../src/analytics/context.ts'
import type { Bar } from '../src/analytics/context-wire.ts'
import { MARKET_CLOSED } from '../src/analytics/snapshot.ts'
import type { HistoryBar, HistoryDay } from '../src/market/history.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { NIFTY_W1, NIFTY_W2, OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'

const M = r3Master()
/** Monday 19 Oct 2026, 10:30 IST: in session. */
const NOW = Date.parse('2026-10-19T10:30:00+05:30')
const OPEN = Date.parse('2026-10-19T09:15:00+05:30')
const MIN = 60_000
const TCS_SPOT = spotTokenOf(M, 'TCS') as number
const TCS_OCT = M.options.future('TCS', OCT)?.instrumentToken as number
const NIFTY_SPOT = INDEX_SPOT_TOKENS['NIFTY'] as number
const NIFTY_FUT = 1010

function deps(o: {
  quotes?: ReturnType<typeof fakeQuotes>
  bars?: Record<string, HistoryBar[]>
  latest?: Record<string, HistoryDay>
  intraday?: Record<string, Bar[]>
  since?: number | null
  eodClose?: number | null
} = {}): ContextDeps {
  return {
    master: () => M,
    quotes: o.quotes ?? fakeQuotes(),
    history: { bars: (s, n) => (o.bars?.[s] ?? []).slice(-n), latest: (s) => o.latest?.[s] ?? null },
    intraday: { bars: (s, _i, of = 'spot') => o.intraday?.[`${s}|${of}`] ?? [], coverage: () => ({ day: '2026-10-19', since: o.since ?? null }) },
    eod: { close: () => o.eodClose ?? null },
  }
}

/** TCS quoted: spot 3400, the Oct future 3412.5, the Oct chain priced at 30% vol. */
function tcsQuotes(): ReturnType<typeof fakeQuotes> {
  const q = fakeQuotes()
  q.set(TCS_SPOT, { price: 3400, asOf: NOW })
  q.set(TCS_OCT, { price: 3412.5, asOf: NOW })
  priceChain(q, M, 'TCS', OCT, 3412.5, 0.3, NOW)
  return q
}

/** `n` daily bars ending Fri 16 Oct, one calendar day apart, closes rising by `step` to `last`. */
function rising(n: number, last: number, step: number, o: { src?: 'cash' | 'fut'; iv?: (i: number) => number | null } = {}): HistoryBar[] {
  const end = Date.parse('2026-10-16T00:00:00Z')
  return Array.from({ length: n }, (_, i) => {
    const c = last - (n - 1 - i) * step
    return {
      date: new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      open: c - step / 2, high: c + 20, low: c - 20, close: c, volume: 1000,
      futClose: c + 5, futOi: 100, ceOi: 1000, peOi: 1200, atmIv: o.iv?.(i) ?? null, maxPain: null, src: o.src ?? 'cash',
    }
  })
}

const bar = (i: number, c: number, v: number): Bar => ({ t: OPEN + i * 5 * MIN, o: c - 1, h: c + 3, l: c - 4, c, v })

test('no history: nulls with warnings, a live IV and the expected move, round numbers only', async () => {
  const c = await marketContextOf(deps({ quotes: tcsQuotes() }), 'TCS', NOW)
  assert.ok(c !== null)
  assert.deepEqual([c.stock, c.asOf, c.closed, c.feedAlive, c.stale, c.reference, c.spot, c.future, c.prevClose, c.changePct],
    ['TCS', NOW, false, true, false, 'spot', 3400, 3412.5, null, null])
  assert.deepEqual(c.day, { open: null, high: null, low: null, vwap: null, orHigh: null, orLow: null })
  assert.deepEqual({ ...c.trend, basis: '' }, { label: 'unknown', sma20: null, sma50: null, sma200: null, ret5d: null, ret20d: null, basis: '' })
  assert.deepEqual({ ...c.vol, atmIv: null }, { atr14: null, hv10: null, hv20: null, atmIv: null, ivRank: null, ivPercentile: null, ivMinusHv20: null, ivDays: 0 })
  assert.equal(c.vol.atmIv, 0.3, 'the Oct chain was priced at 30%')
  const days = yearsToExpiry(OCT, NOW) * 365
  assert.deepEqual(c.expectedMove, {
    expiry: OCT, days: Math.round(days * 100) / 100,
    oneSigma: Math.round(3412.5 * c.vol.atmIv! * Math.sqrt(days / 365) * 100) / 100,
    twoSigma: Math.round(2 * 3412.5 * c.vol.atmIv! * Math.sqrt(days / 365) * 100) / 100,
  })
  assert.equal(c.oi, null)
  assert.deepEqual(c.levels.map((l) => [l.price, l.kind, l.strength, l.distancePct]),
    [[3350, 'round', 1, -1.47], [3400, 'round', 1, 0], [3450, 'round', 1, 1.47], [3500, 'round', 2, 2.94]])
  assert.deepEqual([c.nearestSupport?.price, c.nearestResistance?.price], [3350, 3450])
  assert.deepEqual(c.bars, { daily: 0, intraday: 0 })
  for (const w of [
    'no daily history for TCS yet (no end-of-day summary lists it): trend, ATR, HV, IV rank, pivots, swings and OI levels are unknown',
    'IV rank and percentile need 60 days of IV history; 0 exist',
    "no ticks of TCS's spot sampled today: today's open, high, low, VWAP and opening range are unknown",
  ]) assert.ok(c.warnings.includes(w), `${w}\nnot in\n${c.warnings.join('\n')}`)
})

test('no history and no quotes: every price null, no levels, said', async () => {
  const c = await marketContextOf(deps(), 'TCS', NOW)
  assert.ok(c !== null)
  assert.deepEqual([c.spot, c.future, c.stale, c.vol.atmIv, c.expectedMove.oneSigma, c.expectedMove.twoSigma, c.nearestSupport, c.nearestResistance],
    [null, null, true, null, null, null, null, null])
  assert.equal(c.expectedMove.expiry, OCT, 'the near expiry is listed whatever the quotes')
  assert.deepEqual(c.levels, [])
  assert.ok(c.warnings.includes('no live spot price and no history for TCS: no levels'), c.warnings.join('\n'))
  assert.ok(c.warnings.includes('no ATM IV for TCS: no live two-sided quote at the money and none in the last end-of-day summary'), c.warnings.join('\n'))
})

test('an unknown stock is null', async () => {
  assert.equal(await marketContextOf(deps({ quotes: tcsQuotes() }), 'INFY', NOW), null)
})

test('a year of history, today\'s bars and the OI view: trend, IV rank, day block, OI and levels', async () => {
  const daily = rising(260, 3388.5, 1.5, { iv: (i) => (i >= 160 ? 0.2 + (i % 40) / 400 : null) })
  const latest: HistoryDay = {
    date: '2026-10-16', src: 'cash', fut: { expiry: OCT, close: 3393.5, oi: 100 },
    opt: { expiry: OCT, ceOi: 1000, peOi: 1200, atm: null, walls: { ce: [[3500, 900], [3450, 400]], pe: [[3300, 800]] }, maxPain: 3350 },
  }
  const today = Array.from({ length: 15 }, (_, i) => bar(i, 3395 + (i % 5), 100 + i))
  const c = await marketContextOf(deps({ quotes: tcsQuotes(), bars: { TCS: daily }, latest: { TCS: latest }, intraday: { 'TCS|spot': today }, since: OPEN - 30 * MIN }), 'TCS', NOW)
  assert.ok(c !== null)
  assert.equal(c.prevClose, 3388.5)
  assert.equal(c.changePct, Math.round(((3400 - 3388.5) / 3388.5) * 10_000) / 100)
  assert.equal(c.trend.label, 'up')
  assert.equal(c.trend.sma20, Math.round((3388.5 - 9.5 * 1.5) * 100) / 100)
  assert.equal(c.vol.atr14, 40, 'every true range is the 40 of high − low')
  assert.equal(c.vol.ivDays, 100)
  assert.ok(c.vol.ivRank !== null && c.vol.ivPercentile !== null)
  assert.equal(c.vol.ivMinusHv20, Math.round((c.vol.atmIv! - c.vol.hv20!) * 10_000) / 10_000)
  assert.equal(c.day.open, today[0]!.o)
  assert.deepEqual([c.day.high, c.day.low], [3402, 3391])
  assert.deepEqual([c.day.orHigh, c.day.orLow], [3400, 3391])
  assert.ok(c.day.vwap !== null)
  assert.deepEqual(c.oi, { expiry: OCT, pcr: 1.2, maxPain: 3350, callWall: 3500, putWall: 3300, day: '2026-10-16' })
  const kinds = new Set(c.levels.map((l) => l.kind))
  for (const k of ['pivot', '52w-high', 'oi-call-wall', 'oi-put-wall', 'sma50'] as const) assert.ok(kinds.has(k), k)
  // max pain (3350) is 1.75 from the SMA50 (3351.75): folded into it, and named at its own price
  assert.ok(c.levels.find((l) => l.kind === 'sma50')?.basis.includes('max pain, 27 Oct expiry, 16 Oct file at 3350'))
  // the 16 Oct high (3408.5) is also the 52-week high and R1: one level, the bases joined
  const top = c.levels.find((l) => l.kind === '52w-high')
  assert.deepEqual([top?.price, top?.strength], [3408.5, 3])
  assert.match(top?.basis ?? '', /^52-week high, 16 Oct; high of 16 Oct; classic R1 off 16 Oct/)
  assert.ok(c.levels.length <= 24)
  for (const l of c.levels) assert.equal(l.distancePct, Math.round(((l.price - 3400) / 3400) * 10_000) / 100)
  assert.ok(c.nearestSupport !== null && c.nearestSupport.price < 3400 && c.nearestResistance !== null && c.nearestResistance.price > 3400)
  assert.deepEqual(c.bars, { daily: 260, intraday: 15 })
  assert.deepEqual(c.warnings, [], 'nothing to warn about')
})

test('an index: bars, levels, change and day block are the near future\'s; no live IV falls back to the last day\'s', async () => {
  const q = fakeQuotes()
  q.set(NIFTY_SPOT, { price: 25010, asOf: NOW })
  q.set(NIFTY_FUT, { price: 25060, asOf: NOW })
  const daily = rising(60, 25000, 10, { src: 'fut', iv: () => 0.14 })
  const fut = [bar(0, 25050, 500), bar(1, 25070, 700)]
  const c = await marketContextOf(deps({ quotes: q, bars: { NIFTY: daily }, intraday: { 'NIFTY|future': fut, 'NIFTY|spot': [bar(0, 1, 0)] }, since: OPEN - MIN }), 'NIFTY', NOW)
  assert.ok(c !== null)
  assert.deepEqual([c.reference, c.spot, c.future, c.prevClose], ['future', 25010, 25060, 25000])
  assert.equal(c.changePct, 0.24)
  assert.equal(c.day.high, 25073, 'the future\'s bars, not the spot\'s')
  assert.equal(c.vol.atmIv, 0.14)
  assert.equal(c.expectedMove.expiry, NIFTY_W1)
  const days = yearsToExpiry(NIFTY_W1, NOW) * 365
  assert.equal(c.expectedMove.oneSigma, Math.round(25060 * 0.14 * Math.sqrt(days / 365) * 100) / 100)
  for (const l of c.levels) assert.equal(l.distancePct, Math.round(((l.price - 25060) / 25060) * 10_000) / 100)
  for (const w of [
    "NSE's end-of-day files carry no OHLC for NIFTY: its daily bars, levels, change and day figures are its near future's, measured from the future",
    "no live ATM IV for NIFTY (no two-sided quote at the money): ATM IV is the 16 Oct close's, from the end-of-day summary",
    '60 daily bars of NIFTY: SMA200 needs 200, the 52-week high/low 250',
  ]) assert.ok(c.warnings.includes(w), `${w}\nnot in\n${c.warnings.join('\n')}`)
})

test('bars that start after the open: no open or opening range, said', async () => {
  const late = [bar(21, 3400, 10), bar(22, 3402, 10)]   // 11:00 and 11:05
  const c = await marketContextOf(deps({ quotes: tcsQuotes(), intraday: { 'TCS|spot': late }, since: OPEN + 107 * MIN }), 'TCS', OPEN + 115 * MIN)
  assert.ok(c !== null)
  assert.deepEqual([c.day.open, c.day.orHigh, c.day.orLow, c.day.high, c.day.low], [null, null, null, 3405, 3396])
  assert.ok(c.warnings.includes('today\'s bars are built in memory from 11:02 IST, when the app began sampling: the open and opening range are unknown; high, low and VWAP are since then'),
    c.warnings.join('\n'))
  assert.ok(c.levels.some((l) => l.kind === 'day-high' && l.basis.includes('since the app began sampling')))
})

test('a closed market: closed, stale, said first; an expired OI view and an old summary are said', async () => {
  const sunday = Date.parse('2026-10-25T12:00:00+05:30')
  const q = fakeQuotes()
  q.set(TCS_SPOT, { price: 3400, asOf: sunday - 2 * 86_400_000, stale: true })
  const latest: HistoryDay = {
    date: '2026-10-16', src: 'cash', fut: null,
    opt: { expiry: '2026-10-20', ceOi: 1, peOi: 1, atm: null, walls: { ce: [[3500, 9]], pe: [] }, maxPain: 3400 },
  }
  const c = await marketContextOf(deps({ quotes: q, bars: { TCS: rising(5, 3390, 1) }, latest: { TCS: latest } }), 'TCS', sunday)
  assert.ok(c !== null)
  assert.deepEqual([c.closed, c.stale, c.warnings[0]], [true, true, MARKET_CLOSED])
  assert.equal(c.oi, null)
  assert.ok(c.levels.every((l) => l.kind !== 'oi-call-wall' && l.kind !== 'max-pain'))
  assert.ok(c.warnings.includes('the last end-of-day OI of TCS (16 Oct) is of the 20 Oct expiry, which has passed: no OI levels'), c.warnings.join('\n'))
  assert.ok(c.warnings.includes("the newest end-of-day summary of TCS is of 16 Oct; 22 Oct's is missing"), c.warnings.join('\n'))
  assert.ok(!c.warnings.some((w) => w.startsWith('no ticks')), 'a Sunday has no session to sample')
})

test('with the vol snapshots the context carries the end-of-day vol view: near/next IV, VRP and its history, skew, NSE HV', async () => {
  const daily = rising(100, 3400, 1, { iv: () => 0.3 })
  const day = {
    date: '2026-10-16', nearExpiry: OCT, nextExpiry: '2026-11-24', rolled: false, atmStrike: 3400, nearIv: 0.31, nearIvSource: 'nse' as const,
    nextIv: 0.29, skew25: 0.0212345, spot: 3400, future: 3405, nseHv: 0.27, notes: ['skew: no traded strike near 25 delta on both sides'],
  }
  const withVol: ContextDeps = { ...deps({ quotes: tcsQuotes(), bars: { TCS: daily } }), vol: { days: (s) => (s === 'TCS' ? [day] : []) } }
  const c = await marketContextOf(withVol, 'TCS', NOW)
  assert.ok(c !== null)
  const v = c.vol
  assert.deepEqual([v.volAsOf, v.ivSource, v.nearExpiry, v.nearIv, v.nextExpiry, v.nextIv, v.skew25, v.nseHv],
    ['2026-10-16', 'nse', OCT, 0.31, '2026-11-24', 0.29, 0.0212, 0.27])
  assert.ok(Math.abs((v.vrp as number) - (0.31 - (v.hv20 as number))) < 2e-4, `${v.vrp} ${v.hv20}`)
  assert.equal(typeof v.vrpRatio, 'number')
  assert.equal(v.realizedVrp?.days, 80)   // 100 days: pairs t = 0…79
  assert.ok(c.warnings.includes('end-of-day vol: skew: no traded strike near 25 delta on both sides'), c.warnings.join(' | '))
  assert.equal(c.warnings.some((w) => w.startsWith('end-of-day vol: IV rank needs')), false)
  // without the store the fields are left out altogether
  const bare = await marketContextOf(deps({ quotes: tcsQuotes(), bars: { TCS: daily } }), 'TCS', NOW)
  assert.equal(bare !== null && 'vrp' in bare.vol, false)
})

/** Saturday 17 Oct 2026, 10:00 IST: closed; the last session is Friday 16 Oct. */
const SAT = Date.parse('2026-10-17T10:00:00+05:30')
const FRI_CLOSE = Date.parse('2026-10-16T15:29:00+05:30')

/** TCS as the market left it on Friday: quotes stamped 15:29, the Oct chain at 30%. */
function fridayQuotes(): ReturnType<typeof fakeQuotes> {
  const q = fakeQuotes()
  q.set(TCS_SPOT, { price: 3400, asOf: FRI_CLOSE })
  q.set(TCS_OCT, { price: 3412.5, asOf: FRI_CLOSE })
  priceChain(q, M, 'TCS', OCT, 3412.5, 0.3, FRI_CLOSE)
  return q
}

test('closed, with the last session in the history: the ATM IV is that session\'s end-of-day IV, not its quotes re-solved at a later clock', async () => {
  assert.equal(lastClosedSession(SAT), '2026-10-16')
  assert.equal(lastClosedSession(Date.parse('2026-10-19T09:00:00+05:30')), '2026-10-16', 'Monday before the close reads Friday')
  assert.equal(lastClosedSession(Date.parse('2026-10-19T15:31:00+05:30')), '2026-10-19')
  const c = await marketContextOf(deps({ quotes: fridayQuotes(), bars: { TCS: rising(60, 3400, 1, { iv: () => 0.12 }) } }), 'TCS', SAT)
  assert.ok(c !== null && c.closed)
  assert.equal(c.vol.atmIv, 0.12)
  assert.ok(c.warnings.includes("market closed: ATM IV is the 16 Oct close's, from the end-of-day summary"), c.warnings.join('\n'))
})

test('closed, the history short of that session: the quotes are solved at their own time, so a weekend does not inflate the IV', async () => {
  const thru15 = rising(60, 3400, 1, { iv: () => 0.12 }).slice(0, -1)
  const c = await marketContextOf(deps({ quotes: fridayQuotes(), bars: { TCS: thru15 } }), 'TCS', SAT)
  assert.ok(c !== null)
  // solved at Saturday's clock the same prices read ~31.1% (10.2 days left instead of 11)
  assert.ok(Math.abs((c.vol.atmIv as number) - 0.3) < 1e-3, `${c.vol.atmIv}`)
})

test('the live IV is the first expiry a week or more out: a 1-day weekly never is', async () => {
  const q = fakeQuotes()
  q.set(NIFTY_SPOT, { price: 25010, asOf: NOW })
  q.set(NIFTY_FUT, { price: 25060, asOf: NOW })
  priceChain(q, M, 'NIFTY', NIFTY_W1, 25060, 0.5, NOW)    // 20 Oct: 1 day out
  priceChain(q, M, 'NIFTY', NIFTY_W2, 25060, 0.15, NOW)   // 27 Oct: 8 days out
  const daily = rising(60, 25000, 10, { src: 'fut', iv: () => 0.14 })
  const c = await marketContextOf(deps({ quotes: q, bars: { NIFTY: daily } }), 'NIFTY', NOW)
  assert.ok(c !== null)
  assert.ok(Math.abs((c.vol.atmIv as number) - 0.15) < 1e-3, `${c.vol.atmIv}`)
  assert.equal(c.expectedMove.expiry, NIFTY_W1, 'the expected move is still to the near expiry')
})

test('a corporate action the history adjusted across is said, with its date', async () => {
  const withAdj: ContextDeps = {
    ...deps({ quotes: tcsQuotes(), bars: { TCS: rising(60, 3400, 1) } }),
    history: {
      bars: (_s, n) => rising(60, 3400, 1).slice(-n), latest: () => null,
      adjustments: () => [{ date: '2026-09-21', ratio: 0.5, kind: 'corporate' }, { date: '2026-09-28', ratio: 1.004, kind: 'roll' }],
    },
  }
  const c = await marketContextOf(withAdj, 'TCS', NOW)
  assert.ok(c !== null)
  const said = c.warnings.filter((w) => w.includes('scaled'))
  assert.deepEqual(said, ["TCS's daily prices before 21 Sep are scaled ×0.5000: NSE's previous close that day is not the close before (a corporate action)"])
})
