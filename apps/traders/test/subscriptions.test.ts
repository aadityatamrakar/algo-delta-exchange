import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TradersDb } from '../src/db.ts'
import { planTokens, startDeclaring, wantedTokens } from '../src/market/subscriptions.ts'
import type { TraderLeg } from '../src/types.ts'
import {
  DEC, NIFTY_OCT_FUT, NIFTY_SPOT, NIFTY_WK, NOV, OCT, TCS_DEC_FUT, TCS_NOV_FUT, TCS_OCT_FUT, TCS_SPOT, decCE, decPE, niftyWkCE, niftyWkPE, novCE,
  octCE, octPE, testMaster,
} from './fixtures/master.ts'

const m = testMaster()
const TODAY = '2026-10-19'
const price = (map: Record<number, number>) => (t: number): number | null => map[t] ?? null

function leg(o: Partial<TraderLeg>): TraderLeg {
  return {
    trader: 'ravi', stock: 'TCS', instrument: 'option', expiry: OCT, strike: null, optType: null, qty: 175, avgPrice: 10,
    clientCode: 'C0001', source: 'odin', key: Math.random().toString(), token: null, note: '', updatedAt: 0, ...o,
  }
}
const heldOct = (strike: number, optType: 'CE' | 'PE' = 'CE'): TraderLeg =>
  leg({ strike, optType, token: optType === 'CE' ? octCE(strike) : octPE(strike) })

test('spot, the future, ATM ± 15 and the held strike: 64 tokens', () => {
  const tokens = wantedTokens([heldOct(3500)], m, price({ [TCS_SPOT]: 3510 }), TODAY)
  assert.equal(tokens.length, 64)
  for (const t of [TCS_SPOT, TCS_OCT_FUT, octCE(3125), octPE(3125), octCE(3875), octPE(3875)]) assert.ok(tokens.includes(t))
  assert.equal(tokens.includes(octCE(3100)), false)
  assert.equal(tokens.includes(octCE(3900)), false)
  assert.deepEqual(tokens, [...tokens].sort((a, b) => a - b))
})
test('a held strike outside the window is added: 65', () => {
  const tokens = wantedTokens([heldOct(3500), heldOct(3950, 'PE')], m, price({ [TCS_SPOT]: 3510 }), TODAY)
  assert.equal(tokens.length, 65)
  assert.ok(tokens.includes(octPE(3950)))
})
test('no prices yet: the window centres on the held strikes', () => {
  const tokens = wantedTokens([heldOct(3400), heldOct(3600, 'PE')], m, price({}), TODAY)
  for (const t of [octCE(3125), octPE(3875)]) assert.ok(tokens.includes(t))
  assert.equal(tokens.includes(octCE(3100)), false)
})
test('two expiries declare both futures and both windows', () => {
  const tokens = wantedTokens(
    [heldOct(3500), leg({ expiry: NOV, strike: 3500, optType: 'CE', token: novCE(3500) })], m, price({ [TCS_SPOT]: 3510 }), TODAY)
  for (const t of [TCS_OCT_FUT, TCS_NOV_FUT, novCE(3500), octCE(3500)]) assert.ok(tokens.includes(t))
})
test('the nearest future is declared even when no leg holds that month', () => {
  const nov = wantedTokens([leg({ expiry: NOV, strike: 3500, optType: 'CE', token: novCE(3500) })], m, price({}), TODAY)
  assert.ok(nov.includes(TCS_OCT_FUT))
  const shares = wantedTokens([leg({ instrument: 'share', expiry: '', strike: null, optType: null })], m, price({}), TODAY)
  assert.deepEqual(shares, [TCS_OCT_FUT, TCS_SPOT])
})
test('an index weekly declares spot, its window and the nearest monthly future', () => {
  const tokens = wantedTokens(
    [leg({ stock: 'NIFTY', expiry: NIFTY_WK, strike: 25500, optType: 'PE', token: niftyWkPE(25500) })], m, price({ 256265: 25510 }), TODAY)
  assert.ok(tokens.includes(256265))
  assert.ok(tokens.includes(niftyWkCE(25250)))
  assert.ok(tokens.includes(NIFTY_OCT_FUT))
})
test('expired legs are not declared', () => {
  const tokens = wantedTokens([heldOct(3500)], m, price({ [TCS_SPOT]: 3510 }), '2026-10-28')
  assert.deepEqual(tokens, [TCS_SPOT, TCS_NOV_FUT].sort((a, b) => a - b))
})
test('a stock whose legs have all expired keeps spot and nearest future for 3 days after its last expiry, then drops out', () => {
  const sp = price({ [TCS_SPOT]: 3510 })
  assert.deepEqual(wantedTokens([heldOct(3500)], m, sp, '2026-10-29'), [TCS_NOV_FUT, TCS_SPOT])   // 27 Oct + 2
  assert.deepEqual(wantedTokens([heldOct(3500)], m, sp, '2026-10-30'), [])                        // 27 Oct + 3
  const novLeg = leg({ expiry: NOV, strike: 3500, optType: 'CE', token: novCE(3500) })
  assert.deepEqual(wantedTokens([heldOct(3500), novLeg], m, sp, '2026-11-26'), [TCS_DEC_FUT, TCS_SPOT])   // the last expiry counts
  assert.deepEqual(wantedTokens([heldOct(3500), novLeg], m, sp, '2026-11-27'), [])
  const share = leg({ instrument: 'share', expiry: '', strike: null, optType: null })
  assert.deepEqual(wantedTokens([heldOct(3500), share], m, sp, '2026-11-27'), [TCS_DEC_FUT, TCS_SPOT])   // shares never expire
})

// ---- the cap ----------------------------------------------------------------

const SPOT = price({ [TCS_SPOT]: 3510, [NIFTY_SPOT]: 25510 })
const novLeg = (strike: number, optType: 'CE' | 'PE' = 'CE') => leg({ expiry: NOV, strike, optType, token: optType === 'CE' ? novCE(strike) : novCE(strike) + 1 })
const decLeg = (strike: number, optType: 'CE' | 'PE' = 'CE') => leg({ expiry: DEC, strike, optType, token: optType === 'CE' ? decCE(strike) : decPE(strike) })
/** TCS 3500 CE in Oct, Nov and Dec at spot 3510: spot, three futures and three ATM ± 15 windows of 62 tokens = 190. */
const threeMonths = (): TraderLeg[] => [heldOct(3500), novLeg(3500), decLeg(3500)]
/** Strikes each side of the money declared for Oct, Nov and Dec (every held strike here is at the money). */
const widths = (tokens: readonly number[]) =>
  [20000, 30000, 50000].map((base) => (tokens.filter((t) => t >= base && t < base + 100).length / 2 - 1) / 2)

test('over the cap the ATM windows narrow 15 → 10 → 5 → 0, far months before near', () => {
  const cases: [cap: number, octNovDec: number[], count: number][] = [
    [190, [15, 15, 15], 190], [189, [15, 15, 10], 170], [150, [15, 10, 10], 150], [149, [10, 10, 10], 130],
    [110, [10, 10, 5], 110], [70, [5, 5, 5], 70], [50, [5, 5, 0], 50], [10, [0, 0, 0], 10],
  ]
  for (const [cap, want, count] of cases) {
    const p = planTokens(threeMonths(), m, SPOT, TODAY, { cap })
    assert.deepEqual(widths(p.tokens), want, `cap ${cap}`)
    assert.equal(p.tokens.length, count, `cap ${cap}`)
    assert.deepEqual([p.wanted, p.capHit, p.overCap, [...p.trimmed]], [190, cap < 190, false, cap < 190 ? ['TCS'] : []], `cap ${cap}`)
  }
  assert.deepEqual(planTokens(threeMonths(), m, SPOT, TODAY, { cap: 10 }).tokens,
    [TCS_OCT_FUT, TCS_NOV_FUT, TCS_DEC_FUT, octCE(3500), octPE(3500), novCE(3500), novCE(3500) + 1, decCE(3500), decPE(3500), TCS_SPOT])
})
test('far months go first across stocks: a later TCS month is narrowed before a NIFTY weekly', () => {
  const legs = [novLeg(3500), leg({ stock: 'NIFTY', expiry: NIFTY_WK, strike: 25500, optType: 'PE', token: niftyWkPE(25500) })]
  assert.equal(planTokens(legs, m, SPOT, TODAY, { cap: Infinity }).tokens.length, 109)
  const p = planTokens(legs, m, SPOT, TODAY, { cap: 108 })
  assert.equal(p.tokens.length, 89)
  assert.deepEqual([...p.trimmed], ['TCS'])
  assert.ok(!p.tokens.includes(novCE(3125)) && p.tokens.includes(novCE(3250)))
  assert.ok(p.tokens.includes(niftyWkCE(25000)) && p.tokens.includes(niftyWkCE(26000)))
})
test('held strikes, spots and futures are never dropped; over the cap at 0 they are declared anyway', () => {
  const legs = [heldOct(3500), heldOct(3200, 'PE'), decLeg(3950, 'PE')]
  const p = planTokens(legs, m, SPOT, TODAY, { cap: 1 })
  assert.deepEqual(p.tokens, [TCS_OCT_FUT, TCS_DEC_FUT, octPE(3200), octCE(3500), octPE(3500), decCE(3500), decPE(3500), decPE(3950), TCS_SPOT])
  assert.deepEqual([p.capHit, p.overCap], [true, true])
})
test('other sources (Market Watch) yield to the books: declared only beside their full windows, never narrowing one (Ruling R3-18)', () => {
  // the books want 190 (spot, three futures, three full windows): two more fit under 192, not under 191
  const fits = planTokens(threeMonths(), m, SPOT, TODAY, { cap: 192, extra: [7, 8] })
  assert.deepEqual([fits.wanted, fits.tokens.length, fits.extraDropped, fits.capHit, widths(fits.tokens)], [190, 192, false, false, [15, 15, 15]])
  assert.ok(fits.tokens.includes(7) && fits.tokens.includes(8))
  const full = planTokens(threeMonths(), m, SPOT, TODAY, { cap: 191, extra: [7, 8] })
  assert.deepEqual(
    [full.wanted, full.tokens.length, full.extraDropped, full.capHit, full.overCap, [...full.trimmed], widths(full.tokens)],
    [190, 190, true, false, false, [], [15, 15, 15]],
  )
  assert.ok(!full.tokens.includes(7) && !full.tokens.includes(8))
  // a token a book already declares costs nothing
  const shared = planTokens(threeMonths(), m, SPOT, TODAY, { cap: 190, extra: [TCS_SPOT, TCS_OCT_FUT] })
  assert.deepEqual([shared.tokens.length, shared.extraDropped], [190, false])
  // the books over the cap by themselves: narrowed for their own sake only, and nothing else declared
  const over = planTokens(threeMonths(), m, SPOT, TODAY, { cap: 150, extra: [7, 8] })
  assert.deepEqual([over.wanted, over.tokens.length, over.extraDropped, widths(over.tokens)], [190, 150, true, [15, 10, 10]])
})
test('the declaration never passes the cap because of other sources', () => {
  const many = Array.from({ length: 5000 }, (_, i) => 900_000 + i)
  for (const cap of [10, 150, 190, 191, 2000]) {
    const p = planTokens(threeMonths(), m, SPOT, TODAY, { cap, extra: many })
    assert.deepEqual(p.tokens, planTokens(threeMonths(), m, SPOT, TODAY, { cap }).tokens, `cap ${cap}`)
    assert.ok(p.tokens.length <= cap, `cap ${cap}: ${p.tokens.length}`)
    assert.equal(p.overCap, false, `cap ${cap}`)
  }
})

function fakeDb(fail = false): { db: TradersDb; published: { tokens: readonly number[]; at: number }[] } {
  const published: { tokens: readonly number[]; at: number }[] = []
  const db = {
    publishSubscription: async (tokens: readonly number[], at: number) => {
      if (fail) throw new Error('mongo down')
      published.push({ tokens, at })
    },
  } as unknown as TradersDb
  return { db, published }
}

test('refreshNow publishes the union with added sources; a failure is logged, not thrown', async () => {
  const { db, published } = fakeDb()
  const logs: string[] = []
  const d = startDeclaring({
    db, legs: async () => [heldOct(3500)], master: () => m, priceOf: price({ [TCS_SPOT]: 3510 }),
    now: () => Date.parse('2026-10-19T05:00:00Z'), log: (msg) => void logs.push(msg), everyMs: 3_600_000,
  })
  d.addTokenSource('mw', () => [7, 8])
  d.addTokenSource('bad', () => { throw new Error('boom') })
  const tokens = await d.refreshNow()
  const last = published[published.length - 1]
  assert.ok(last !== undefined && last.tokens.includes(7) && last.tokens.includes(8) && last.tokens.includes(TCS_SPOT))
  assert.equal(tokens.length, 66)
  assert.ok(logs.some((l) => l.includes('token source failed')))
  assert.deepEqual(d.last(), { count: 66, at: Date.parse('2026-10-19T05:00:00Z'), capHit: false, trimmed: new Set(), bookDemand: 64 })
  d.stop()

  const failing = fakeDb(true)
  const logs2: string[] = []
  const d2 = startDeclaring({
    db: failing.db, legs: async () => [], master: () => m, priceOf: price({}), now: () => 1, log: (msg) => void logs2.push(msg), everyMs: 3_600_000,
  })
  await d2.refreshNow()
  assert.ok(logs2.length > 0)
  d2.stop()
})

test('the declarer applies TRADERS_MAX_TOKENS, reports the hit, and logs when trimming starts, changes and ends', async () => {
  const { db, published } = fakeDb()
  const logs: { msg: string; f: Record<string, unknown> | undefined }[] = []
  let legs = threeMonths()
  const d = startDeclaring({
    db, legs: async () => legs, master: () => m, priceOf: SPOT, now: () => Date.parse('2026-10-19T05:00:00Z'),
    log: (msg, f) => void logs.push({ msg, f }), everyMs: 3_600_000, maxTokens: 150,
  })
  await d.refreshNow()
  assert.equal(published.at(-1)!.tokens.length, 150)
  assert.deepEqual([d.last().count, d.last().capHit, [...d.last().trimmed]], [150, true, ['TCS']])
  assert.deepEqual(logs.map((l) => l.msg), ['traders feed cap reached: ATM windows narrowed'])
  assert.deepEqual(logs[0]!.f, { cap: 150, wanted: 190, declared: 150, trimmed: ['TCS'] })
  await d.refreshNow()
  assert.equal(logs.length, 1)   // the same trim again is not logged again
  legs = [heldOct(3500)]
  await d.refreshNow()
  assert.deepEqual([d.last().count, d.last().capHit, [...d.last().trimmed]], [64, false, []])
  assert.deepEqual(logs.map((l) => l.msg).slice(1), ['traders feed cap no longer reached: full ATM windows declared'])
  d.stop()

  const tiny = fakeDb()
  const loud: string[] = []
  const d2 = startDeclaring({
    db: tiny.db, legs: async () => threeMonths(), master: () => m, priceOf: SPOT, now: () => 1, log: (msg) => void loud.push(msg),
    everyMs: 3_600_000, maxTokens: 5,
  })
  await d2.refreshNow()
  assert.equal(tiny.published.at(-1)!.tokens.length, 10)   // published anyway
  assert.deepEqual(loud, ['TRADERS FEED CAP EXCEEDED: spots, futures and held strikes alone are over TRADERS_MAX_TOKENS; declared anyway'])
  d2.stop()
})

test('a source that succeeds and then throws keeps its tokens in the next publish', async () => {
  const { db, published } = fakeDb()
  const d = startDeclaring({
    db, legs: async () => [], master: () => m, priceOf: price({}), now: () => 1, log: () => {}, everyMs: 3_600_000,
  })
  let fail = false
  d.addTokenSource('mw', () => { if (fail) throw new Error('transient'); return [7, 8] })
  d.addTokenSource('never', () => { throw new Error('always') })
  await d.refreshNow()
  fail = true
  const tokens = await d.refreshNow()
  assert.ok(tokens.includes(7) && tokens.includes(8))
  assert.ok(published[published.length - 1]?.tokens.includes(7))
  d.stop()
})

test("the declarer reports the books' own full demand, and says once when other sources are left out and once when they are back (Ruling R3-18)", async () => {
  const { db, published } = fakeDb()
  const logs: { msg: string; f: Record<string, unknown> | undefined }[] = []
  let legs = [heldOct(3500)]
  const d = startDeclaring({
    db, legs: async () => legs, master: () => m, priceOf: SPOT, now: () => 1, log: (msg, f) => void logs.push({ msg, f }),
    everyMs: 3_600_000, maxTokens: 190,
  })
  d.addTokenSource('market-watch', () => Array.from({ length: 100 }, (_, i) => 900_000 + i))
  await d.refreshNow()
  assert.deepEqual([d.last().bookDemand, d.last().count, d.last().capHit], [64, 164, false])
  legs = threeMonths()
  await d.refreshNow()
  assert.deepEqual([d.last().bookDemand, d.last().count, d.last().capHit, [...d.last().trimmed]], [190, 190, false, []])
  assert.equal(published.at(-1)!.tokens.some((t) => t >= 900_000 && t < 900_100), false)
  await d.refreshNow()
  legs = [heldOct(3500)]
  await d.refreshNow()
  assert.equal(d.last().count, 164)
  assert.deepEqual(logs.map((l) => l.msg), [
    "traders feed cap: other screens' tokens left out — the books' full windows need the room",
    "traders feed cap: other screens' tokens no longer left out",
  ])
  assert.deepEqual(logs[0]!.f, { cap: 190, wanted: 190, left: 100, sources: ['market-watch'] })
  d.stop()
})
