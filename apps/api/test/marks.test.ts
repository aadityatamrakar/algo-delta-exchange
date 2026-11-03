import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InstrumentRef } from '@algomaker/order-bus'
import { QuoteCache } from '../src/marks.ts'

const ref = (instrumentToken: number): InstrumentRef => ({
  tradingsymbol: `T${instrumentToken}`,
  instrumentToken,
  lotSize: 2625,
  tickSize: 0.05,
  exchange: 'NFO',
})

/** Controllable clock, so tick cadence can be simulated exactly. */
function cache(opts: { feedDeadAfterMs?: number; staleAfterMs?: number } = {}): {
  c: QuoteCache
  tick: (ms: number) => void
  at: () => number
} {
  let t = 1_000_000
  const c = new QuoteCache({ ...opts, now: () => t })
  return { c, tick: (ms) => { t += ms }, at: () => t }
}

test('a fresh mark is returned with its age', () => {
  const { c, tick } = cache()
  c.update(1, 15.05)
  tick(2000)
  const m = c.mark(1)
  assert.equal(m?.price, 15.05)
  assert.equal(m?.ageMs, 2000)
  assert.equal(m?.stale, false)
})

test('an ILLIQUID contract keeps its mark — BHEL ticks every ~30s', () => {
  // Measured on the live BHEL Aug chain 2026-07-27: 2 ticks in 60 seconds. A
  // 15s age limit made every mark absent, so the bridge booked nothing. A
  // 90-second-old quote on a strike that trades twice a minute IS the market.
  const { c, tick } = cache()
  c.update(1, 15.05)
  tick(30_000)
  c.update(2, 11) // a DIFFERENT token ticks — the feed is demonstrably alive
  tick(60_000)
  const m = c.mark(1)
  assert.ok(m !== null, 'an illiquid mark must not vanish while the feed is alive')
  assert.equal(m.price, 15.05)
  assert.equal(m.ageMs, 90_000)
  assert.equal(m.stale, true, 'but it must be REPORTED as stale')
})

test('a DEAD feed makes every price absent, however recently cached', () => {
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  c.update(1, 15.05)
  assert.equal(c.feedAlive(), true)
  tick(120_001)
  assert.equal(c.feedAlive(), false)
  assert.equal(c.mark(1), null, 'a frozen socket is the dangerous failure')
  assert.equal(c.price(ref(1)), null)
  assert.equal(c.spot('BHEL'), null)
})

test('ANY token ticking keeps the whole feed alive', () => {
  // The discriminator is feed-wide. One liquid index token ticking proves the
  // socket is healthy, so illiquid strikes on the same connection stay usable.
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  c.update(1, 15.05)
  for (let i = 0; i < 10; i++) {
    tick(60_000)
    c.update(999, 22_000) // NIFTY spot, ticking constantly
  }
  assert.equal(c.feedAlive(), true)
  assert.ok(c.mark(1) !== null, 'the illiquid strike survives 10 minutes of not trading')
  assert.equal(c.mark(1)?.stale, true)
})

test('before ANY tick the feed is not alive', () => {
  const { c } = cache()
  assert.equal(c.feedAlive(), false)
  assert.equal(c.price(ref(1)), null)
  assert.equal(c.ageOfNewestTick(), Number.POSITIVE_INFINITY)
})

test('feed liveness uses ARRIVAL time, not the packet timestamp', () => {
  // A broker replaying stale timestamps must not be able to look alive.
  const { c, tick, at } = cache({ feedDeadAfterMs: 60_000 })
  c.update(1, 15, at() - 500_000) // ancient exchange timestamp
  assert.equal(c.feedAlive(), true, 'it ARRIVED now')
  const m = c.mark(1)
  assert.ok((m?.ageMs ?? 0) >= 500_000, 'but the mark itself is correctly reported as ancient')
  tick(60_001)
  assert.equal(c.feedAlive(), false)
})

test('implausible prices are rejected at ingest and do not revive the feed', () => {
  const { c } = cache()
  c.update(1, 0)
  c.update(1, -5)
  c.update(1, Number.NaN)
  assert.equal(c.mark(1), null)
  assert.equal(c.feedAlive(), false, 'a rejected tick is not evidence of a live feed')
})

test('staleCount and ageOfNewestTick drive the health display', () => {
  const { c, tick } = cache({ staleAfterMs: 60_000 })
  c.update(1, 10)
  c.update(2, 11)
  tick(61_000)
  c.update(3, 12)
  assert.equal(c.staleCount(), 2)
  assert.equal(c.size, 3)
  assert.equal(c.ageOfNewestTick(), 0)
})

test('an instrument with no token never resolves a price', () => {
  const { c } = cache()
  c.update(1, 10)
  assert.equal(c.price({ tradingsymbol: 'X', lotSize: 1, tickSize: 0.05, exchange: 'NFO' }), null)
})

test('quote carries oi, volume and the timestamp of the tick', () => {
  const { c } = cache()
  c.update(700420, 15.4, 999_000, { oi: 123_400, volume: 8_800 })

  const q = c.quote(700420)
  assert.ok(q)
  assert.equal(q.price, 15.4)
  assert.equal(q.oi, 123_400)
  assert.equal(q.volume, 8_800)
  assert.equal(q.asOf, 999_000)
  assert.equal(q.ageMs, 1_000)
  assert.equal(q.stale, false)
})

test('quote is null when the feed is dead, even though the cache is full', () => {
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  c.update(700420, 15.4, undefined, { oi: 1, volume: 2 })
  tick(200_000)
  assert.equal(c.quote(700420), null)
})

test('a tick without oi or volume leaves them null rather than zero', () => {
  const { c } = cache()
  c.update(700420, 15.4)
  assert.equal(c.quote(700420)?.oi, null)
  assert.equal(c.quote(700420)?.volume, null)
})

test('quote is null for a token that has never ticked', () => {
  const { c } = cache()
  c.update(1, 10) // some other token ticks, so the feed is alive
  assert.equal(c.quote(999), null)
})

// ------------------------------------- option vs spot liveness (audit F-15)

test('a SPOT publisher alone no longer keeps option marks alive', () => {
  // The F-15 failure verbatim: an option-chain resubscription fails after an
  // expiry roll, the one spot publisher keeps ticking, and every strike marks
  // at yesterday's price with `complete: true`.
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  c.update(1, 15.05)
  for (let i = 0; i < 10; i++) {
    tick(60_000)
    c.updateSpot('BHEL', 220.4)
  }
  assert.equal(c.feedAlive(), false, 'no OPTION tick for ten minutes is a dead option feed')
  assert.equal(c.mark(1), null)
  assert.equal(c.price(ref(1)), null)
  assert.equal(c.spot('BHEL'), 220.4, 'the spot feed is genuinely alive and says so')
})

test('and the reverse: option ticks do not keep a dead SPOT feed alive', () => {
  // Symmetric on purpose. Spot drives every greek; a frozen spot with live
  // options would compute delta against a price nobody is trading at.
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  c.updateSpot('BHEL', 220.4)
  for (let i = 0; i < 10; i++) {
    tick(60_000)
    c.update(1, 15.05)
  }
  assert.equal(c.feedAlive(), true)
  assert.ok(c.mark(1) !== null)
  assert.equal(c.spot('BHEL'), null, 'ten minutes without a spot tick is a dead spot feed')
})

test('displaySpot still renders the last known spot when its feed is dead', () => {
  // DISPLAY may use last-known marks; EXECUTION may not. The split clock must
  // not blank the dashboard out of hours.
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  c.updateSpot('BHEL', 220.4)
  tick(600_000)
  assert.equal(c.spot('BHEL'), null)
  assert.equal(c.displaySpot('BHEL', null), 220.4)
})

// --------------------------------------------- per-token mark age (F-16)

test('markAge reports how old a contract mark is', () => {
  const { c, tick } = cache()
  c.update(1, 15.05)
  tick(660_000)
  c.update(2, 9) // something on the feed is still ticking, so the feed is alive
  assert.equal(c.markAge(ref(1)), 660_000)
  assert.equal(c.markAge(ref(2)), 0)
})

test('markAge is null for an unknown token, a tokenless ref, and a dead feed', () => {
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  assert.equal(c.markAge(ref(1)), null, 'never ticked')
  assert.equal(
    c.markAge({ tradingsymbol: 'X', lotSize: 1, tickSize: 0.05, exchange: 'NFO' }),
    null,
    'no token to look up',
  )
  c.update(1, 15.05)
  tick(120_001)
  assert.equal(c.markAge(ref(1)), null, 'a dead feed has no ages, only absent prices')
})

// ---------------------------------------------------------------- the mid

test('a tick carrying depth marks at the MID, not the LTP', () => {
  // TCS 2440PE, 2026-08-17: LTP 116 printed at 14:20 while the 115.50/117.15
  // book moved every second. The last trade is a memory; the book is the
  // market. Everything that reads this cache — greeks, paper fills, the chain
  // the Python desk prices off, marketable limits — marks at the mid whenever
  // both sides exist.
  const { c } = cache()
  c.update(1, 116, undefined, { bid: 115.5, ask: 117.15 })
  assert.equal(c.mark(1)?.price, (115.5 + 117.15) / 2)
  assert.equal(c.quote(1)?.price, (115.5 + 117.15) / 2)
  assert.equal(c.price(ref(1)), (115.5 + 117.15) / 2)
  // …and the pair itself is served: "0.20 / 0.24" answers a question the mid
  // cannot — how wide is the market an order would actually cross.
  assert.equal(c.quote(1)?.bid, 115.5)
  assert.equal(c.quote(1)?.ask, 117.15)
})

test('a quote with no depth serves null bid/ask, never zeros', () => {
  const { c } = cache()
  c.update(1, 116)
  assert.equal(c.quote(1)?.bid, null)
  assert.equal(c.quote(1)?.ask, null)
})

test('a tick with no depth falls back to the LTP, and a later depth tick upgrades it', () => {
  const { c } = cache()
  c.update(1, 116)
  assert.equal(c.mark(1)?.price, 116)
  c.update(1, 116, undefined, { bid: 115, ask: 117 })
  assert.equal(c.mark(1)?.price, 116)
  // one-sided or zero depth on a LATER tick must not preserve the old mid
  c.update(1, 118, undefined, { bid: 0, ask: 117 })
  assert.equal(c.mark(1)?.price, 118)
})

test('the persisted snapshot carries the effective (mid) price', () => {
  // The snapshot seeds displayMark after a restart; persisting the raw LTP
  // would resurrect exactly the stale price the mid exists to replace.
  const { c } = cache()
  c.update(1, 116, undefined, { bid: 115.5, ask: 117.15 })
  const rows = c.snapshot()
  assert.equal(rows[0]?.price, (115.5 + 117.15) / 2)
})

test('displayQuote serves the cached quote past a dead feed, age intact', () => {
  // The closed-market cockpit prices its chain off this: at 7pm every quote is
  // hours old and the feed is rightly dead, but the last session's mid is the
  // only honest price there is — served with its true age, never laundered.
  const { c, tick } = cache()
  c.update(1, 116, undefined, { bid: 115.5, ask: 117.15, oi: 900, volume: 12 })
  tick(2 * 60 * 60 * 1000)
  assert.equal(c.quote(1), null, 'the decision path must still refuse')
  const q = c.displayQuote(1)
  assert.equal(q?.price, (115.5 + 117.15) / 2)
  assert.equal(q?.ageMs, 2 * 60 * 60 * 1000)
  assert.equal(q?.stale, true)
  assert.equal(q?.oi, 900)
})

test('displayQuote falls back to the persisted snapshot, extras null', () => {
  const { c, tick, at } = cache()
  const ts = at() - 3 * 60 * 60 * 1000
  c.loadSnapshot([{ token: 7, price: 42.4, ts }])
  tick(1000)
  const q = c.displayQuote(7)
  assert.equal(q?.price, 42.4)
  assert.equal(q?.asOf, ts)
  assert.equal(q?.stale, true)
  // The snapshot knows only a price and a time — never invent depth or oi.
  assert.equal(q?.bid, null)
  assert.equal(q?.oi, null)
  assert.equal(c.displayQuote(8), null, 'a token nobody ever saw stays absent')
})

// ------------------------------------------------------------- exit-side reads

test('exitQuote values the exit side of the last two-sided frame', () => {
  const { c } = cache()
  c.update(1, 10, undefined, { bid: 9.8, ask: 10.2 })
  assert.equal(c.exitQuote(1, 'Sell')?.price, 9.8, 'closing a long sells at the bid')
  assert.equal(c.exitQuote(1, 'Sell')?.basis, 'bid')
  assert.equal(c.exitQuote(1, 'Buy')?.price, 10.2, 'closing a short buys at the ask')
  assert.equal(c.exitQuote(1, 'Buy')?.basis, 'ask')
  assert.equal(c.exitQuote(1, null)?.price, 10, 'no direction → mid')
  assert.equal(c.exitQuote(1, null)?.basis, 'mid')
})

test('an LTP-only tick AGES the book frame instead of erasing it', () => {
  const { c, tick, at } = cache()
  const frameAt = at()
  c.update(1, 10, undefined, { bid: 9.8, ask: 10.2 })
  tick(30_000)
  c.update(1, 11) // a trade print with no depth — the book is older, not gone
  const q = c.exitQuote(1, 'Buy')
  assert.equal(q?.price, 10.2, 'still the book, never the print')
  assert.equal(q?.asOf, frameAt, "the frame's own timestamp")
  assert.equal(q?.ageMs, 30_000, 'aged, and says so')
})

test('no book frame ever seen → null, never an LTP stand-in', () => {
  const { c } = cache()
  c.update(1, 10) // LTP only, forever
  assert.equal(c.exitQuote(1, 'Buy'), null)
  assert.equal(c.exitQuote(1, null), null)
})

test('exitQuote refuses on a dead feed exactly as mark() does', () => {
  const { c, tick } = cache({ feedDeadAfterMs: 120_000 })
  c.update(1, 10, undefined, { bid: 9.8, ask: 10.2 })
  tick(300_000)
  assert.equal(c.exitQuote(1, 'Buy'), null)
})

test('displayExitQuote falls back to a persisted pair, basis snapshot', () => {
  const { c, at } = cache()
  const ts = at() - 3 * 60 * 60 * 1000
  c.loadSnapshot([{ token: 1, price: 10, ts, bid: 9.8, ask: 10.2 }])
  const q = c.displayExitQuote(1, 'Buy')
  assert.equal(q?.price, 10.2)
  assert.equal(q?.basis, 'snapshot')
  assert.equal(q?.stale, true)
  // A legacy snapshot row without a pair prices NOTHING here: display may be
  // old, it may not be a last print.
  c.loadSnapshot([{ token: 2, price: 5, ts }])
  assert.equal(c.displayExitQuote(2, 'Buy'), null)
})
