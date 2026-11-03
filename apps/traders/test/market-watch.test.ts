import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Greeks, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import type { EodContract } from '@algomaker/span'
import type { EodStatus } from '../src/analytics/eod.ts'
import {
  INDEX_STRIKES_EACH_SIDE, buildMarketWatch, isIndex, marketExpiries, marketInputOf, marketStrikes, marketTokens,
  type MarketWatchInput, type MarketWatchView,
} from '../src/analytics/market-watch.ts'
import { MARKET_CLOSED } from '../src/analytics/snapshot.ts'
import { spotTokenOf, type TradersMaster } from '../src/market/master.ts'
import type { TradersQuotes } from '../src/market/quotes.ts'
import { DEC, NIFTY_W1, NIFTY_W2, NIFTY_W3, NOV, OCT, SENSEX_W1, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'

/** 2026-10-19 10:30 IST, a Monday in session. */
const AS_OF = Date.UTC(2026, 9, 19, 5, 0)
const VOL = 0.3
const FO = 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'
const CM = 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv'
const TCS_FORWARDS: readonly (readonly [string, number])[] = [[OCT, 3412.5], [NOV, 3430], [DEC, 3450]]

type Eod = MarketWatchInput['eod']
const eodOf = (status: EodStatus, close: (c: EodContract) => number | null = () => null, oi: (c: EodContract) => number | null = () => null): Eod =>
  ({ close, oi, status: () => status })
const FILES_READ: EodStatus = { day: '2026-10-16', fo: FO, cm: CM, missing: [] }
const NO_EOD = eodOf(FILES_READ)

const token = (m: TradersMaster, stock: string, expiry: string, strike: number, type: 'CE' | 'PE'): number =>
  m.options.resolve(stock, expiry, strike, type)?.instrumentToken as number

function tcs(opts?: { feedAlive?: boolean; asOf?: number }): { m: TradersMaster; q: ReturnType<typeof fakeQuotes> } {
  const asOf = opts?.asOf ?? AS_OF
  const m = r3Master()
  const q = fakeQuotes(opts)
  q.set(spotTokenOf(m, 'TCS') as number, { price: 3400, asOf })
  for (const [e, f] of TCS_FORWARDS) {
    q.set(m.options.future('TCS', e)?.instrumentToken as number, { price: f, asOf })
    priceChain(q, m, 'TCS', e, f, VOL, asOf)
  }
  return { m, q }
}

/** Quotes with some tokens taken away. */
const without = (q: TradersQuotes, hidden: readonly number[]): TradersQuotes =>
  ({ quote: (t) => (hidden.includes(t) ? null : q.quote(t)), feedAlive: () => q.feedAlive() })

function view(m: TradersMaster, q: TradersQuotes, stock: string, o?: { eod?: Eod; asOf?: number; fullChains?: boolean }): MarketWatchView {
  const input = marketInputOf(m, q, o?.eod ?? NO_EOD, stock, o?.asOf ?? AS_OF, o?.fullChains ?? true)
  assert.ok(input, `${stock} has listed expiries`)
  return buildMarketWatch(input)
}

const rowAt = (v: MarketWatchView, expiry: string, strike: number) => {
  const r = v.chains.find((c) => c.expiry === expiry)?.rows.find((x) => x.strike === strike)
  assert.ok(r, `${expiry} ${strike} is a row`)
  return r
}

test('three chains in expiry order', () => {
  const { m, q } = tcs()
  const v = view(m, q, 'TCS')
  assert.deepEqual(v.chains.map((c) => c.expiry), [OCT, NOV, DEC])
  assert.deepEqual(v.chains.map((c) => c.forwardSource), ['future', 'future', 'future'])
  assert.deepEqual(v.chains.map((c) => c.forward), [3412.5, 3430, 3450])
  assert.deepEqual(v.chains.map((c) => c.future?.ltp), [3412.5, 3430, 3450])
  assert.deepEqual(v.chains.map((c) => [c.lotSize, c.step, c.rows.length]), [[175, 50, 5], [175, 50, 5], [175, 50, 5]])
  assert.deepEqual([v.stock, v.asOf, v.spot, v.feedAlive, v.fullChains], ['TCS', AS_OF, 3400, true, true])
})

test('an index takes its first three listed expiries', () => {
  const m = r3Master()
  assert.deepEqual(marketExpiries(m, 'NIFTY', '2026-10-19'), [NIFTY_W1, NIFTY_W2, NIFTY_W3])
  assert.deepEqual(marketExpiries(m, 'NIFTY', NIFTY_W2), [NIFTY_W2, NIFTY_W3])   // an expiry day still lists its own expiry
  assert.deepEqual(marketExpiries(m, 'INFY', '2026-10-19'), [])
  assert.deepEqual([isIndex('NIFTY'), isIndex('SENSEX'), isIndex('TCS'), isIndex('CONSTRUCTOR')], [true, true, false, false])
})

test('an index gets ATM ± 40 strikes; a stock gets every strike', () => {
  const m = r3Master()
  const nifty = marketStrikes(m, 'NIFTY', NIFTY_W1, 25010)
  assert.equal(INDEX_STRIKES_EACH_SIDE, 40)
  assert.equal(nifty.length, 81)
  assert.deepEqual([nifty[0], nifty.at(-1)], [23000, 27000])
  assert.equal(marketStrikes(m, 'TCS', OCT, 3400).length, 5)
  // no spot: the middle of the listed strikes; near the end of the list the window is cut short
  assert.deepEqual([marketStrikes(m, 'NIFTY', NIFTY_W1, null)[0], marketStrikes(m, 'NIFTY', NIFTY_W1, null).length], [23000, 81])
  assert.deepEqual([marketStrikes(m, 'NIFTY', NIFTY_W1, 29990).length, marketStrikes(m, 'NIFTY', NIFTY_W1, 29990).at(-1)], [41, 30000])
})

test('marketTokens counts', () => {
  const { m, q } = tcs()
  assert.equal(marketTokens(m, q, 'TCS', '2026-10-19').length, 1 + 3 + 30)
  q.set(spotTokenOf(m, 'NIFTY') as number, { price: 25010, asOf: AS_OF })
  const nifty = marketTokens(m, q, 'NIFTY', '2026-10-19')
  assert.equal(nifty.length, 1 + 1 + 3 * 81 * 2)
  assert.equal(new Set(nifty).size, nifty.length)
  assert.ok(nifty.includes(m.options.future('NIFTY', NIFTY_W2)?.instrumentToken as number))
  assert.ok(nifty.includes(token(m, 'NIFTY', NIFTY_W3, 23000, 'PE')) && !nifty.includes(token(m, 'NIFTY', NIFTY_W3, 22950, 'PE')))
})

test('a weekly with no future is headed by its forward', () => {
  const m = r3Master()
  const q = fakeQuotes()
  q.set(spotTokenOf(m, 'NIFTY') as number, { price: 25010, asOf: AS_OF })
  priceChain(q, m, 'NIFTY', NIFTY_W1, 25040, VOL, AS_OF)
  const v = view(m, q, 'NIFTY')
  const w1 = v.chains[0]!
  assert.deepEqual([w1.expiry, w1.future, w1.forwardSource, w1.rows.length, w1.lotSize], [NIFTY_W1, null, 'parity', 81, 75])
  assert.ok(Math.abs((w1.forward ?? 0) - 25040) < 1e-6, String(w1.forward))
  const ce = rowAt(v, NIFTY_W1, 25000).ce
  assert.ok(ce !== null && ce.iv !== null && Math.abs(ce.iv - VOL) < 1e-4, JSON.stringify(ce))
  // W2 lists a future but nothing is quoted on it: said as an unpriced, stale future, and valued off spot carried
  assert.deepEqual([v.chains[1]!.future, v.chains[1]!.forwardSource], [{ ltp: null, change: null, changePct: null, ageMs: null, stale: true }, 'carry'])
  assert.equal(v.chains[2]!.future, null)   // W3 lists none
})

test("SENSEX: OI change and price change are blank with the BSE sentence", () => {
  const m = r3Master()
  const q = fakeQuotes()
  q.set(spotTokenOf(m, 'SENSEX') as number, { price: 81000, asOf: AS_OF })
  priceChain(q, m, 'SENSEX', SENSEX_W1, 81050, VOL, AS_OF)
  for (const k of m.options.strikes('SENSEX', SENSEX_W1)) q.set(token(m, 'SENSEX', SENSEX_W1, k, 'CE'), { oi: 5000 })
  // an end-of-day reader that answers for anything: BSE contracts are still not read from it
  const v = view(m, q, 'SENSEX', { eod: eodOf(FILES_READ, () => 100, () => 1000) })
  assert.ok(v.warnings.includes("SENSEX trades on BSE; NSE's end-of-day files do not cover it — OI change and price change unknown"), v.warnings.join('\n'))
  assert.equal(v.oiDay, null)
  assert.deepEqual(v.chains.map((c) => c.expiry), [SENSEX_W1])
  const sides = v.chains[0]!.rows.flatMap((r) => [r.ce, r.pe]).filter((s) => s !== null)
  assert.equal(sides.length, 2 * 21)
  for (const s of sides) assert.deepEqual([s.change, s.changePct, s.oiChange], [null, null, null])
  assert.equal(rowAt(v, SENSEX_W1, 81000).ce?.oi, 5000)
})

test('the IV solved from a Black-76 price is that vol', () => {
  const { m, q } = tcs()
  const v = view(m, q, 'TCS')
  const ce = rowAt(v, OCT, 3400).ce
  assert.ok(ce !== null && ce.iv !== null)
  assert.ok(Math.abs(ce.iv - VOL) < 1e-4, String(ce.iv))
  assert.equal(ce.ivSource, 'quote')
  const g = b76Greeks({ future: 3412.5, strike: 3400, t: yearsToExpiry(OCT, AS_OF), vol: VOL, rate: DEFAULT_RATE, type: 'CE' })
  assert.ok(Math.abs((ce.delta as number) - g.delta) < 1e-6, `${ce.delta} vs ${g.delta}`)
  assert.ok(Math.abs((ce.gamma as number) - g.gamma) < 1e-6)
  assert.ok(Math.abs((ce.vega as number) - g.vega) < 1e-4)
  assert.ok(Math.abs((ce.theta as number) - g.theta) < 1e-4)
  // the VolHedge columns are read off the chain's own LTPs
  const p = (k: number): number => rowAt(v, OCT, k).ce?.ltp as number
  assert.ok(Math.abs((ce.bf as number) - (p(3350) - 2 * p(3400) + p(3450))) < 1e-9)
  assert.ok(Math.abs((ce.bf2 as number) - (p(3300) - 2 * p(3400) + p(3500))) < 1e-9)
  assert.ok(Math.abs((ce.ratio as number) - (p(3400) - 2 * p(3450))) < 1e-9)
  const row = rowAt(v, OCT, 3400)
  assert.ok(Math.abs((row.straddle as number) - (p(3400) + (row.pe?.ltp as number))) < 1e-9)
  assert.equal(rowAt(v, OCT, 3500).ce?.bf, null)   // the wing has no strike past it
})

test('OI and price change against the previous day', () => {
  const { m, q } = tcs()
  const mine = (c: EodContract): boolean =>
    c.stock === 'TCS' && c.instrument === 'option' && c.expiry === OCT && c.strike === 3400 && c.optType === 'CE'
  q.set(token(m, 'TCS', OCT, 3400, 'CE'), { price: 64.4, oi: 150000 })
  const eod = eodOf(FILES_READ, (c) => (mine(c) ? 61.35 : null), (c) => (mine(c) ? 125000 : null))
  const v = view(m, q, 'TCS', { eod })
  const ce = rowAt(v, OCT, 3400).ce
  assert.ok(ce !== null)
  assert.equal(ce.oiChange, 25000)
  assert.ok(Math.abs((ce.change as number) - 3.05) < 1e-9, String(ce.change))
  assert.ok(Math.abs((ce.changePct as number) - 4.971) < 1e-3, String(ce.changePct))
  assert.equal(v.oiDay, '2026-10-16')
  assert.deepEqual([rowAt(v, OCT, 3400).pe?.change, rowAt(v, OCT, 3400).pe?.oiChange], [null, null])   // no row for it in the file
  assert.deepEqual(v.warnings, [])
})

test("a future's change is against its own close", () => {
  const { m, q } = tcs()
  const eod = eodOf(FILES_READ, (c) => (c.instrument === 'future' && c.expiry === NOV && c.strike === null && c.optType === null ? 3400 : null))
  const v = view(m, q, 'TCS', { eod })
  assert.deepEqual(v.chains[1]!.future, { ltp: 3430, change: 30, changePct: 30 / 3400 * 100, ageMs: 0, stale: false })
  assert.deepEqual([v.chains[0]!.future?.change, v.chains[0]!.future?.changePct], [null, null])
})

test('a missing end-of-day file → blanks, with the file named', () => {
  const { m, q } = tcs()
  for (const k of m.options.strikes('TCS', OCT)) q.set(token(m, 'TCS', OCT, k, 'CE'), { oi: 150000 })
  const v = view(m, q, 'TCS', { eod: eodOf({ day: '2026-10-16', fo: null, cm: CM, missing: [FO] }) })
  for (const c of v.chains) {
    assert.deepEqual([c.future?.change, c.future?.changePct], [null, null])
    for (const s of c.rows.flatMap((r) => [r.ce, r.pe])) assert.deepEqual([s?.change, s?.changePct, s?.oiChange], [null, null, null])
  }
  assert.equal(v.oiDay, null)
  assert.ok(v.warnings.includes(`NSE end-of-day file ${FO} for 16 Oct is missing — OI change and price change unknown`), v.warnings.join('\n'))
})

test('a file that does not parse is named with its error; a missing cash file is not Market Watch’s', () => {
  const { m, q } = tcs()
  const bad = view(m, q, 'TCS', { eod: eodOf({ day: '2026-10-16', fo: null, cm: CM, missing: [`${FO}: no header`] }) })
  assert.deepEqual(bad.warnings, [`NSE end-of-day file ${FO} for 16 Oct could not be read (no header) — OI change and price change unknown`])
  const cash = view(m, q, 'TCS', { eod: eodOf({ day: '2026-10-16', fo: FO, cm: null, missing: [CM] }) })
  assert.deepEqual([cash.warnings, cash.oiDay], [[], '2026-10-16'])
})

test('a side with no quote is null, not zeros', () => {
  const { m, q } = tcs()
  const v = view(m, without(q, [token(m, 'TCS', OCT, 3400, 'PE'), token(m, 'TCS', OCT, 3450, 'CE'), token(m, 'TCS', OCT, 3450, 'PE')]), 'TCS')
  const r = rowAt(v, OCT, 3400)
  assert.equal(r.pe, null)
  assert.notEqual(r.ce, null)
  assert.equal(r.straddle, null)
  assert.deepEqual([rowAt(v, OCT, 3450).ce, rowAt(v, OCT, 3450).pe, rowAt(v, OCT, 3450).straddle], [null, null, null])
  // the neighbours' BF needs the missing strike's price
  assert.equal(rowAt(v, OCT, 3400).ce?.bf, null)
})

test("a side whose own quote does not solve borrows the other side's IV and says so", () => {
  const { m, q } = tcs()
  q.set(token(m, 'TCS', OCT, 3400, 'CE'), { price: 0.05 })   // under its intrinsic value: no vol prices it
  const ce = rowAt(view(m, q, 'TCS'), OCT, 3400).ce
  assert.ok(ce !== null && ce.iv !== null)
  assert.equal(ce.ivSource, 'other-side')
  assert.ok(Math.abs(ce.iv - VOL) < 1e-4)
  assert.notEqual(ce.delta, null)

  // nothing measured anywhere in the month (every quote older than the solve's window): no vol, no greeks
  const { m: m2, q: q2 } = tcs()
  for (const k of m2.options.strikes('TCS', OCT)) for (const t of ['CE', 'PE'] as const) q2.set(token(m2, 'TCS', OCT, k, t), { ageMs: 600_000 })
  const stale = rowAt(view(m2, q2, 'TCS'), OCT, 3400).ce
  assert.ok(stale !== null)
  assert.deepEqual([stale.iv, stale.ivSource, stale.delta, stale.gamma, stale.vega, stale.theta], [null, 'none', null, null, null, null])
  assert.equal(stale.ageMs, 600_000)
  assert.ok((stale.ltp as number) > 0)   // the price is still shown, with its age
})

test('a quote the cache calls stale is flagged stale: sides, futures and the spot', () => {
  const { m, q } = tcs()
  const v0 = view(m, q, 'TCS')
  assert.deepEqual([v0.spotStale, v0.chains[0]!.future?.stale, rowAt(v0, OCT, 3400).ce?.stale], [false, false, false])
  // the stored desk snapshot, or a tick older than a minute: still shown, never as live
  q.set(spotTokenOf(m, 'TCS') as number, { stale: true, ageMs: 3_600_000 })
  q.set(m.options.future('TCS', OCT)?.instrumentToken as number, { stale: true })
  q.set(token(m, 'TCS', OCT, 3400, 'CE'), { stale: true })
  const v = view(m, q, 'TCS')
  assert.deepEqual([v.spot, v.spotStale], [3400, true])
  assert.deepEqual([v.chains[0]!.future?.ltp, v.chains[0]!.future?.stale, v.chains[1]!.future?.stale], [3412.5, true, false])
  const r = rowAt(v, OCT, 3400)
  assert.deepEqual([r.ce?.stale, r.pe?.stale, typeof r.ce?.ltp], [true, false, 'number'])
  // no spot quote at all: no price, and not a live one
  const none = view(m, without(q, [spotTokenOf(m, 'TCS') as number]), 'TCS')
  assert.deepEqual([none.spot, none.spotStale], [null, true])
})

test('feed dead', () => {
  const { m, q } = tcs({ feedAlive: false })
  const v = view(m, q, 'TCS')
  assert.equal(v.feedAlive, false)
  assert.ok(v.warnings.includes('the market data feed is dead: every price below is the last one seen'), v.warnings.join('\n'))
})

test("outside the session the view says the market is closed, not that the feed is dead", () => {
  const saturday = Date.UTC(2026, 9, 24, 5, 0)
  const { m, q } = tcs({ feedAlive: false, asOf: saturday })
  const v = view(m, q, 'TCS', { asOf: saturday })
  assert.deepEqual(v.warnings, ["market closed — last session's prices"])
})

test('a weekday NSE holiday with no ticks says the market is closed, not that the feed is dead (R3 final fix I1)', () => {
  const holiday = Date.parse('2026-10-20T11:00:00+05:30')   // Tuesday, Dussehra
  const { m, q } = tcs({ feedAlive: false, asOf: holiday })
  const v = view(m, q, 'TCS', { asOf: holiday })
  assert.deepEqual(v.warnings, [MARKET_CLOSED])
})

test('two listed expiries', () => {
  const after = Date.UTC(2026, 9, 28, 5, 0)   // the day after OCT's expiry
  const { m, q } = tcs({ asOf: after })
  const v = view(m, q, 'TCS', { asOf: after })
  assert.equal(v.chains.length, 2)
  assert.deepEqual(v.chains.map((c) => c.expiry), [NOV, DEC])
  assert.deepEqual(v.warnings, [])
})

test('labels carry the guess wording', () => {
  const { m, q } = tcs()
  const v = view(m, q, 'TCS')
  for (const label of [v.labels.bf, v.labels.bf2, v.labels.ratio]) assert.ok(label.includes('unconfirmed (Phase 0, Q3)'), label)
})

test('fullChains false', () => {
  const { m, q } = tcs()
  const v = view(m, without(q, [token(m, 'TCS', NOV, 3300, 'CE'), token(m, 'TCS', NOV, 3300, 'PE')]), 'TCS', { fullChains: false })
  assert.equal(v.fullChains, false)
  assert.ok(v.warnings.includes('Market Watch is already watching 1,000 contracts for other screens; this one shows only the strikes already watched for open books'),
    v.warnings.join('\n'))
  // only strikes with a price: the ones some other screen already watches
  assert.deepEqual(v.chains[1]!.rows.map((r) => r.strike), [3350, 3400, 3450, 3500])
  assert.equal(v.chains[0]!.rows.length, 5)
  const capped = buildMarketWatch({ ...(marketInputOf(m, q, NO_EOD, 'TCS', AS_OF, false) as MarketWatchInput), maxTokens: 1500 })
  assert.ok(capped.warnings.some((w) => w.startsWith('Market Watch is already watching 1,500 contracts')), capped.warnings.join('\n'))
})

test('over the cap, a strike is watched only while its quote ticks: in session with a live feed a stale one does not count', () => {
  const stale = (q: ReturnType<typeof fakeQuotes>, m: TradersMaster) => {
    q.set(token(m, 'TCS', NOV, 3300, 'CE'), { stale: true }); q.set(token(m, 'TCS', NOV, 3300, 'PE'), { stale: true })
    q.set(token(m, 'TCS', NOV, 3350, 'CE'), { stale: true })   // its PE still ticks
  }
  const live = tcs()
  stale(live.q, live.m)
  assert.deepEqual(view(live.m, live.q, 'TCS', { fullChains: false }).chains[1]!.rows.map((r) => r.strike), [3350, 3400, 3450, 3500])
  assert.equal(view(live.m, live.q, 'TCS', { fullChains: true }).chains[1]!.rows.length, 5)   // a full chain shows every strike
  // a dead feed, or outside the session, every quote is old: any quote counts
  const dead = tcs({ feedAlive: false })
  stale(dead.q, dead.m)
  assert.equal(view(dead.m, dead.q, 'TCS', { fullChains: false }).chains[1]!.rows.length, 5)
  const saturday = Date.UTC(2026, 9, 24, 5, 0)
  const closed = tcs({ asOf: saturday })
  stale(closed.q, closed.m)
  assert.equal(view(closed.m, closed.q, 'TCS', { fullChains: false, asOf: saturday }).chains[1]!.rows.length, 5)
})

test('a name with no listed expiry has no input', () => {
  const { m, q } = tcs()
  assert.equal(marketInputOf(m, q, NO_EOD, 'INFY', AS_OF, true), null)
})
