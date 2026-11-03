import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76ImpliedVol, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import { forwardFor } from '../src/analytics/month-chain.ts'
import { SNAPSHOT_TTL_MS, SnapshotCache, chainIvs, priceBook, rebase, withIlliquid } from '../src/analytics/snapshot.ts'
import type { TradersQuotes } from '../src/market/quotes.ts'
import type { BookSnapshot } from '../src/analytics/snapshot.ts'
import {
  L1, L2, L3, L4, L5, L6, R2_DEC, R2_NOW, R2_OCT, TM, optLeg, optToken, r2Legs, r2Market, r2Quotes,
} from './fixtures/r2-book.ts'

const s = priceBook('asha', 'TCS', r2Legs(), r2Market())
const legOf = (b: BookSnapshot, k: string) => b.legs.find((l) => l.leg.key === k)!
const by = (k: string) => legOf(s, k)
/** A solved vol, so an equality against another solve cannot pass as null === null. */
function vol(x: number | null | undefined): number {
  assert.ok(typeof x === 'number' && Number.isFinite(x) && x > 0, `expected a vol, got ${String(x)}`)
  return x
}

test('each month is solved against its own future and tenor', () => {
  assert.equal(vol(by(L1).marketIv), b76ImpliedVol(60, { future: 3010, strike: 3000, t: yearsToExpiry('2026-10-27', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
  assert.equal(vol(by(L2).marketIv), b76ImpliedVol(95, { future: 3030, strike: 3000, t: yearsToExpiry('2026-11-23', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
  assert.equal(by(L1).ivSource, 'quote')
  assert.deepEqual([by(L1).illiquidAuto, by(L1).ivFrom, by(L1).payoff.iv], [false, null, by(L1).marketIv])
})
test('a stale own quote is auto-illiquid and takes the other side', () =>
  assert.deepEqual([by(L3).illiquidAuto, by(L3).ivSource, by(L3).ivFrom], [true, 'other-side', { strike: 3100, optType: 'PE' }]))
test('a viewer tick forces the fallback', () => {
  const f = withIlliquid(s, new Set([L1])).legs.find((l) => l.leg.key === L1)!
  assert.deepEqual([f.ivSource, f.ivFrom], ['other-side', { strike: 3000, optType: 'PE' }])
  assert.equal(vol(f.marketIv), s.chains['2026-10-27']!.find((x) => x.strike === 3000 && x.type === 'PE')!.iv)
  assert.equal(f.payoff.iv, f.marketIv); assert.equal(f.illiquidAuto, false)
})
test('a tick on a future, a share or a key not in the book changes nothing', () =>
  assert.deepEqual(withIlliquid(s, new Set([L4, L5, 'bala|option|TCS|2026-10-27|3000|CE'])).legs, s.legs))
test('a month with no future prices off R1’s parity forward (Review Focus 1)', () => {
  const n = priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { 11: null } }))
  const fwd = forwardFor(TM, r2Quotes({ 11: null }), 'TCS', '2026-11-23', 3000, R2_NOW)!     // parity at 3000: 3000 + (95 − 75)·e^{rt}
  assert.deepEqual([n.futures['2026-11-23'], n.optionFutures['2026-11-23'], fwd.source], [null, fwd.price, 'parity'])
  assert.equal(vol(legOf(n, L2).marketIv), b76ImpliedVol(95, { future: fwd.price, strike: 3000, t: yearsToExpiry('2026-11-23', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
})
test('a month on carry is named in R1’s words', () => {
  const d = priceBook('asha', 'TCS', [optLeg(R2_DEC, 3000, 'CE', 175, 120)], r2Market())
  assert.ok(d.warnings.includes('2026-12-29 is valued off spot carried to expiry — no future and no two-sided quote at the money'))
  assert.deepEqual([d.futures[R2_DEC], d.legs[0]!.marketIv, d.legs[0]!.ivSource, d.legs[0]!.illiquidAuto], [null, null, 'none', true])
})
test('shares and futures carry no IV; the share prices at spot', () => {
  assert.deepEqual([by(L5).payoff.instrument, by(L5).payoff.expiry, by(L5).ltp, by(L5).marketIv], ['future', '', 3000, null])
  assert.deepEqual([by(L4).payoff.instrument, by(L4).payoff.expiry, by(L4).ltp, by(L4).marketIv, by(L4).ivSource], ['future', '2026-10-27', 3010, null, 'none'])
  assert.deepEqual([by(L4).lotSize, by(L5).lotSize, by(L2).lotSize], [175, 1, 175])
})
test('unmatched legs are listed and left out', () => {
  assert.equal(s.legs.length, 5); assert.equal(s.unmatched.length, 1)
  assert.deepEqual(s.unmatchedKeys, [L6])                     // the same leg, by key (fix round 1: the MTM block leaves it out)
  assert.deepEqual(s.unmatched, ['not understood: TCS 3050 CE 2026-10-27 (client C1) — no such contract in the instrument master'])
})
test('buy/sale price and synthetic future per leg', () => {
  assert.deepEqual([by(L1).bid, by(L1).ask, by(L1).syntheticFuture, by(L3).syntheticFuture, by(L4).syntheticFuture], [59.5, 60.5, 3010, 3010, null])
})
test('the near future is the nearest listed future', () => assert.deepEqual(s.nearFuture, { expiry: '2026-10-27', price: 3010, lotSize: 175 }))
test('the book’s calendar: near and last expiry, every listed expiry, the near chain, ATM per month', () => {
  assert.deepEqual([s.nearExpiry, s.lastExpiry, s.expiries, s.lotSize, s.strikeStep, s.basis, s.closed, s.spot],
    ['2026-10-27', '2026-11-23', ['2026-10-27', '2026-11-23', '2026-12-29'], 175, 100, 'future', false, 3000])
  assert.deepEqual(s.atm, { '2026-10-27': 3000, '2026-11-23': 3000 })
  assert.deepEqual(s.futures, { '2026-10-27': 3010, '2026-11-23': 3030 })
  assert.deepEqual(s.quotes['2026-11-23'], [{ strike: 3000, type: 'CE', price: 95, ageMs: 1000 }, { strike: 3000, type: 'PE', price: 75, ageMs: 1000 }])
})
test('chainIvs is the same solve, for a month nobody holds too', () => {
  assert.deepEqual(chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', '2026-10-27', R2_NOW)!.solved, s.chains['2026-10-27'])
  const dec = chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', '2026-12-29', R2_NOW)!                                   // listed, nothing quoted
  assert.deepEqual([dec.source, dec.solved.length], ['carry', 0])
  assert.equal(chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', '2027-01-26', R2_NOW), null)                               // not listed
})
test('rebase: cash prices every month off spot; synthetic off ATM strike + CE − PE', () => {
  const cash = rebase(s, 'cash'), syn = rebase(s, 'synthetic')
  assert.equal(vol(legOf(cash, L2).marketIv), b76ImpliedVol(95, { future: 3000, strike: 3000, t: yearsToExpiry('2026-11-23', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
  assert.deepEqual([syn.basis, syn.optionFutures['2026-10-27'], syn.optionFutures['2026-11-23'], syn.futures['2026-11-23']], ['synthetic', 3010, 3020, 3030])   // Nov: 3000 + 95 − 75; traded futures untouched
  assert.deepEqual([cash.basis, cash.optionFutures, cash.futures], ['cash', { '2026-10-27': 3000, '2026-11-23': 3000 }, s.futures])
  assert.equal(rebase(s, 'future'), s)
})
test('rebase keeps every leg’s illiquid state: a ticked or stale leg still borrows', () => {
  const cash = rebase(withIlliquid(s, new Set([L1])), 'cash')
  const l1 = cash.legs.find((l) => l.leg.key === L1)!, l3 = cash.legs.find((l) => l.leg.key === L3)!
  assert.deepEqual([l1.ivSource, l1.ivFrom, l3.ivSource, l3.illiquidAuto], ['other-side', { strike: 3000, optType: 'PE' }, 'other-side', true])
  assert.equal(vol(l1.marketIv), cash.chains['2026-10-27']!.find((x) => x.strike === 3000 && x.type === 'PE')!.iv)
  assert.equal(l1.payoff.iv, l1.marketIv)
})
test('rebase re-reads illiquidAuto on the new basis; a viewer tick stays forced', () => {
  // Oct 3100 PE @95 is above its 90 intrinsic on the 3010 future but below its 100 on 3000 spot;
  // Oct 2900 CE @105 is below its 110 on the future but above its 100 on spot.
  const quotes = { [optToken(R2_OCT, 3100, 'PE')]: 95, [optToken(R2_OCT, 2900, 'CE')]: 105 }
  const pe = optLeg(R2_OCT, 3100, 'PE', -175, 90), ce = optLeg(R2_OCT, 2900, 'CE', 175, 100)
  const fut = withIlliquid(priceBook('asha', 'TCS', [pe, ce, r2Legs()[0]!], r2Market({ quotes })), new Set([L1]))
  const cash = rebase(fut, 'cash')
  assert.deepEqual([legOf(fut, pe.key).illiquidAuto, legOf(fut, pe.key).ivSource], [false, 'quote'])
  assert.equal(legOf(cash, pe.key).illiquidAuto, true); assert.notEqual(legOf(cash, pe.key).ivSource, 'quote')
  assert.deepEqual([legOf(fut, ce.key).illiquidAuto, legOf(fut, ce.key).ivSource], [true, 'other-side'])
  assert.deepEqual([legOf(cash, ce.key).illiquidAuto, legOf(cash, ce.key).ivSource, legOf(cash, ce.key).ivFrom], [false, 'quote', null])
  assert.equal(vol(legOf(cash, ce.key).marketIv), cash.chains[R2_OCT]!.find((x) => x.strike === 2900 && x.type === 'CE')!.iv)
  const l1 = legOf(cash, L1)
  assert.deepEqual([l1.illiquidAuto, l1.ivSource, l1.ivFrom], [false, 'other-side', { strike: 3000, optType: 'PE' }])
})
test('rebase takes only a snapshot on the future basis', () => {
  const cash = rebase(s, 'cash')
  assert.throws(() => rebase(cash, 'synthetic'), { message: "rebase takes a snapshot on the future basis, not 'cash'" })
  assert.throws(() => rebase(cash, 'future'), { message: "rebase takes a snapshot on the future basis, not 'cash'" })
  assert.equal(rebase(cash, 'cash'), cash)
})
test('synthetic with no two-sided ATM quote falls back to the forward, warned', () => {
  const n = priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { [optToken('2026-11-23', 3000, 'PE')]: null } }))
  const syn = rebase(n, 'synthetic')
  assert.equal(syn.optionFutures['2026-11-23'], n.optionFutures['2026-11-23'])
  assert.ok(syn.warnings.includes('2026-11-23: no two-sided quote at the 3000 strike — the synthetic basis uses its forward'))
})
test('the near month is known even when no leg holds it', () => {
  const n = priceBook('asha', 'TCS', r2Legs().filter((l) => l.key === L2), r2Market())
  assert.deepEqual([n.nearExpiry, n.futures['2026-10-27'], n.lotSize], ['2026-10-27', 3010, 175])
})
test('market closed: last session prices, labelled', () => {
  const c = priceBook('asha', 'TCS', r2Legs(), r2Market({ now: Date.UTC(2026, 9, 24, 6, 0), ageMs: 2 * 86_400_000 }))
  assert.equal(c.closed, true); assert.notEqual(c.legs[0]!.marketIv, null)
  assert.ok(c.warnings.includes("market closed — last session's prices"))
  assert.equal(c.warnings.some((w) => w.startsWith('the price feed')), false)
})
test('a dead feed in session is said', () =>
  assert.ok(priceBook('asha', 'TCS', r2Legs(), r2Market({ feedAlive: false })).warnings.some((w) => w.startsWith('the price feed is not ticking'))))
test('a live session says nothing about the market', () => assert.deepEqual(s.warnings, []))
test('the cache serves one snapshot per SNAPSHOT_TTL_MS and recomputes on a new upload', () => {
  const real = r2Quotes()
  let calls = 0
  const counting: TradersQuotes = { quote: (t) => { calls++; return real.quote(t) }, feedAlive: () => real.feedAlive() }
  let now = R2_NOW
  const cache = new SnapshotCache({ master: () => TM, quotes: counting, now: () => now })
  const first = cache.get('asha', 'TCS', r2Legs(), 1)
  assert.ok(calls > 0)
  calls = 0
  now = R2_NOW + SNAPSHOT_TTL_MS - 1
  assert.equal(cache.get('asha', 'TCS', r2Legs(), 1), first); assert.equal(calls, 0)
  const upload = cache.get('asha', 'TCS', r2Legs(), 2)
  assert.notEqual(upload, first); assert.ok(calls > 0)
  assert.notEqual(cache.get('bala', 'TCS', r2Legs(), 1), first)
  now = R2_NOW + SNAPSHOT_TTL_MS + 1
  const later = cache.get('asha', 'TCS', r2Legs(), 1)
  assert.notEqual(later, first); assert.equal(later.asOf, now)
})
