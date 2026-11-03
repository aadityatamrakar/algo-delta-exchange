/**
 * TICKS IN, CHAIN SNAPSHOTS OUT — and the four ways that goes quietly wrong.
 *
 * No Mongo, no clock, no bus: every input here is a literal, so this suite
 * runs on a laptop with nothing installed and proves the whole of `ChainView`.
 * That is deliberate — the two sibling suites in this directory are database
 * suites that skip themselves without a server, and a workspace whose only
 * real coverage skips is a workspace that is not covered.
 *
 * The four failures the assertions below exist for, none of which throws:
 *
 *   1. **A half-updated book.** An LTP-only tick that clears the pair leaves
 *      the engine marking off `null` — an unpriced leg — while the book is
 *      sitting there unchanged. The deployed `QuoteCache` retains the last
 *      two-sided frame across LTP-only ticks (`apps/api/src/marks.ts:190-219`,
 *      `:228`) and this must too, or every illiquid short goes unmarked
 *      between prints.
 *   2. **A book that looks fresher than it is.** If an LTP-only tick advanced
 *      `asOf`, a frozen book would age from the last PRINT and "the book is
 *      old" would never fire — the exact tell the desk added on 2026-08-21.
 *   3. **`spot` off a last print.** `ChainSnap.spot` is the forward every
 *      Black-76 greek is taken at. A future's LTP and its mid diverge by half
 *      a spread all session, and greeks priced off the wrong one are wrong in
 *      a way no P&L shows.
 *   4. **A price that outlives its subscription.** The runner kept the last
 *      tick for every token that ever arrived (`apps/runner/src/market-data
 *      .ts:373-403`, audit F-53); a strike that left the window and came back
 *      resurfaced with a price frozen hours earlier. A stale quote is not
 *      inert — it is selectable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChainSnap, OptType, Quote, StrikeQuote } from '@algomaker/desk-engine'
import { ChainView, type ChainToken, type ChainViewDeps } from '../src/chain-view.ts'

const SYMBOL = 'TCS'
const EXPIRY = '2026-08-28'
const LOT = 175
const STEP = 20

const FUT = 900
const CE_2400 = 101
const PE_2400 = 102
const CE_2420 = 103
const PE_2420 = 104

function opt(strike: number, optType: OptType, token: number): ChainToken {
  return { token, strike, optType, instrument: `TCS26AUG${String(strike)}${optType}` }
}

/** The instrument master, reduced to the two questions `ChainView` asks it. */
class FakeChains {
  readonly #rows = new Map<string, ChainToken[]>()
  readonly #futures = new Map<string, number>()

  set(symbol: string, expiry: string, rows: ChainToken[]): void {
    this.#rows.set(`${symbol}|${expiry}`, rows)
  }

  setFuture(symbol: string, token: number): void {
    this.#futures.set(symbol, token)
  }

  deps(): ChainViewDeps {
    return {
      tokensFor: (symbol, expiry) => this.#rows.get(`${symbol}|${expiry}`) ?? [],
      futureToken: (symbol) => this.#futures.get(symbol) ?? 0,
    }
  }
}

/**
 * A view over one TCS chain with both wings on two strikes, and a future.
 *
 * `snap()` IS THE DECLARATION — a token does not say which underlying it
 * belongs to, so until a book has been snapped once this view holds no tokens
 * and every tick on the shared bus is somebody else's. The default fixture
 * therefore snaps once (and gets `null`, because nothing is quoted yet);
 * `fixture(false)` is the boot state, before any book has been asked for.
 */
function fixture(declare = true): { v: ChainView; chains: FakeChains } {
  const chains = new FakeChains()
  chains.setFuture(SYMBOL, FUT)
  chains.set(SYMBOL, EXPIRY, [
    opt(2400, 'CE', CE_2400),
    opt(2400, 'PE', PE_2400),
    opt(2420, 'CE', CE_2420),
    opt(2420, 'PE', PE_2420),
  ])
  const v = new ChainView(chains.deps())
  if (declare) assert.equal(v.snap(SYMBOL, EXPIRY, LOT, STEP), null, 'nothing is quoted yet')
  return { v, chains }
}

function snapOf(v: ChainView): ChainSnap | null {
  return v.snap(SYMBOL, EXPIRY, LOT, STEP)
}

/** The snapshot, or a failure that says the future was missing. */
function must(v: ChainView): ChainSnap {
  const s = snapOf(v)
  assert.notEqual(s, null, 'expected a snapshot')
  return s as ChainSnap
}

function rowOf(snap: ChainSnap, strike: number): StrikeQuote {
  const r = snap.strikes.find((s) => s.strike === strike)
  assert.notEqual(r, undefined, `no row for strike ${String(strike)}`)
  return r as StrikeQuote
}

/** A two-sided future print, so `snap()` has a forward to return. */
function future(v: ChainView, bid: number, ask: number, price: number, ts: number): void {
  v.onTick({ token: FUT, price, ts, bid, ask })
}

// ------------------------------------------------------- both-or-neither

test('an LTP-only tick keeps the book pair — it never half-updates or clears it', () => {
  const { v } = fixture()
  future(v, 2400, 2401, 2400.5, 1_000)
  v.onTick({ token: CE_2400, price: 10.2, ts: 1_000, bid: 10, ask: 10.5 })

  // The print moves; the book does not. This is the ordinary shape of an
  // illiquid strike (TCS 2440PE, 2026-08-17: last print 14:20, book moving
  // every second) and the pair must survive it.
  v.onTick({ token: CE_2400, price: 12, ts: 2_000 })

  const q = rowOf(must(v), 2400).ce
  assert.deepEqual(q, { bid: 10, ask: 10.5, ltp: 12, asOf: 1_000 } satisfies Quote)
})

test('the pair carries the BOOK frame time, so an LTP-only tick cannot make a frozen book look fresh', () => {
  const { v } = fixture()
  future(v, 2400, 2401, 2400.5, 1_000)
  v.onTick({ token: CE_2400, price: 10.2, ts: 1_000, bid: 10, ask: 10.5 })
  for (let i = 1; i <= 5; i += 1) v.onTick({ token: CE_2400, price: 10.2, ts: 1_000 + i * 60_000 })

  assert.equal(rowOf(must(v), 2400).ce?.asOf, 1_000, 'aged from the frame, not the last print')
})

test('a one-sided or crossed tick sets no pair at all', () => {
  const { v } = fixture()
  future(v, 2400, 2401, 2400.5, 1_000)

  v.onTick({ token: CE_2400, price: 10.2, ts: 1_000, bid: 10 })
  assert.deepEqual(rowOf(must(v), 2400).ce, { bid: null, ask: null, ltp: 10.2, asOf: 1_000 })

  // A crossed book is not a book. Same test as `marks.ts:217-219`.
  v.onTick({ token: CE_2400, price: 10.2, ts: 2_000, bid: 11, ask: 10 })
  assert.deepEqual(rowOf(must(v), 2400).ce, { bid: null, ask: null, ltp: 10.2, asOf: 2_000 })

  v.onTick({ token: CE_2400, price: 10.2, ts: 3_000, bid: 0, ask: 10.5 })
  assert.deepEqual(rowOf(must(v), 2400).ce, { bid: null, ask: null, ltp: 10.2, asOf: 3_000 })
})

test('an unpriceable tick is refused at ingest and changes nothing', () => {
  const { v } = fixture()
  future(v, 2400, 2401, 2400.5, 1_000)
  v.onTick({ token: CE_2400, price: 10.2, ts: 1_000, bid: 10, ask: 10.5 })

  v.onTick({ token: CE_2400, price: 0, ts: 2_000, bid: 1, ask: 2 })
  v.onTick({ token: CE_2400, price: Number.NaN, ts: 3_000, bid: 1, ask: 2 })
  v.onTick({ token: CE_2400, price: 9, ts: Number.NaN, bid: 1, ask: 2 })

  assert.deepEqual(rowOf(must(v), 2400).ce, { bid: 10, ask: 10.5, ltp: 10.2, asOf: 1_000 })
  assert.equal(v.touchedSince(1_000), false, 'a refused tick is not a touch')
})

// ------------------------------------------------------------------ snap

test('spot is the MID of the future, never its last print', () => {
  const { v } = fixture()
  // A future that last printed at 2405 under a 2400/2402 book.
  future(v, 2400, 2402, 2405, 1_000)

  const s = must(v)
  assert.equal(s.spot, 2401)
  assert.deepEqual(s.future, { bid: 2400, ask: 2402, ltp: 2405, asOf: 1_000 })
})

test('spot falls back to the future LTP only when the future is genuinely one-sided', () => {
  const { v } = fixture()
  v.onTick({ token: FUT, price: 2405, ts: 1_000 })
  assert.equal(must(v).spot, 2405)
})

test('snap is null until the future has a quote, however well quoted the strikes are', () => {
  const { v } = fixture()
  v.onTick({ token: CE_2400, price: 10.2, ts: 1_000, bid: 10, ask: 10.5 })
  assert.equal(snapOf(v), null)

  future(v, 2400, 2402, 2401, 2_000)
  assert.notEqual(snapOf(v), null)
})

test('a chain with no listed future can never snap', () => {
  const chains = new FakeChains()
  chains.set(SYMBOL, EXPIRY, [opt(2400, 'CE', CE_2400)])
  const v = new ChainView(chains.deps())
  assert.equal(snapOf(v), null)
  v.onTick({ token: CE_2400, price: 10.2, ts: 1_000, bid: 10, ask: 10.5 })
  assert.equal(snapOf(v), null, 'futureToken() answered 0 — there is no forward to price against')
})

test('every listed strike is in the snapshot, and an unquoted wing is null rather than a zero', () => {
  const { v } = fixture()
  future(v, 2400, 2402, 2401, 1_000)
  v.onTick({ token: CE_2400, price: 10.2, ts: 1_500, bid: 10, ask: 10.5 })

  const s = must(v)
  assert.deepEqual(
    s.strikes.map((r) => r.strike),
    [2400, 2420],
    'listed strikes, ascending — a strike that has not traded is a different fact from one that is not listed',
  )
  assert.notEqual(rowOf(s, 2400).ce, null)
  assert.equal(rowOf(s, 2400).pe, null)
  assert.equal(rowOf(s, 2420).ce, null)
  assert.equal(rowOf(s, 2420).pe, null)
})

test('the snapshot carries back what it was asked for, and is as of its newest quote', () => {
  const { v } = fixture()
  future(v, 2400, 2402, 2401, 1_000)
  v.onTick({ token: CE_2400, price: 10.2, ts: 7_000, bid: 10, ask: 10.5 })
  v.onTick({ token: PE_2420, price: 9, ts: 3_000, bid: 8.5, ask: 9.5 })

  const s = must(v)
  assert.equal(s.symbol, SYMBOL)
  assert.equal(s.expiry, EXPIRY)
  assert.equal(s.lotSize, LOT)
  assert.equal(s.step, STEP)
  assert.equal(s.asOf, 7_000)
})

// ---------------------------------------------------------- declared set

test('a tick on a token no declared chain wants is ignored entirely', () => {
  const { v } = fixture()
  future(v, 2400, 2402, 2401, 1_000)
  const before = must(v)

  v.onTick({ token: 55_555, price: 99, ts: 9_000, bid: 98, ask: 100 })

  assert.deepEqual(must(v).strikes, before.strikes, 'nothing was retained for it')
  assert.equal(v.touchedSince(1_000), false, 'and it did not count as the chain being touched')
})

test('a strike that leaves the chain and comes back does NOT come back with its frozen price', () => {
  /**
   * The F-53 failure, reproduced against this class: the runner's `#quotes`
   * kept the last tick for every token that ever arrived, so a contract that
   * left the window and re-entered it hours later was selectable at a price
   * from 10:05. Retention follows the DECLARED set or it follows nothing.
   */
  const { v, chains } = fixture()
  future(v, 2400, 2402, 2401, 1_000)
  v.onTick({ token: CE_2400, price: 10.2, ts: 1_500, bid: 10, ask: 10.5 })
  assert.notEqual(rowOf(must(v), 2400).ce, null)

  chains.set(SYMBOL, EXPIRY, [opt(2420, 'CE', CE_2420), opt(2420, 'PE', PE_2420)])
  assert.deepEqual(
    must(v).strikes.map((r) => r.strike),
    [2420],
  )

  chains.set(SYMBOL, EXPIRY, [opt(2400, 'CE', CE_2400), opt(2420, 'CE', CE_2420)])
  assert.equal(rowOf(must(v), 2400).ce, null, 'the price it held while undeclared was dropped')
})

test('snapping one chain does not forget another chain the same view holds', () => {
  const { v, chains } = fixture()
  const OTHER = '2026-09-24'
  const CE_FAR = 201
  chains.set(SYMBOL, OTHER, [opt(2400, 'CE', CE_FAR)])

  future(v, 2400, 2402, 2401, 1_000)
  // Both chains must be declared before either can retain a tick.
  assert.notEqual(v.snap(SYMBOL, OTHER, LOT, STEP), null)
  v.onTick({ token: CE_FAR, price: 40, ts: 2_000, bid: 39, ask: 41 })
  v.onTick({ token: CE_2400, price: 10.2, ts: 2_000, bid: 10, ask: 10.5 })

  assert.notEqual(rowOf(must(v), 2400).ce, null)
  const far = v.snap(SYMBOL, OTHER, LOT, STEP)
  assert.notEqual(far, null)
  assert.deepEqual(rowOf(far as ChainSnap, 2400).ce, { bid: 39, ask: 41, ltp: 40, asOf: 2_000 })
})

// ------------------------------------------------------------ warm start

test('warmStart seeds a chain that is declared later, and a real tick overrides it', () => {
  const { v } = fixture(false)
  // Boot order: the marks come out of Mongo before any book has been snapped.
  v.warmStart([
    { token: FUT, price: 2405, ts: 500, bid: 2400, ask: 2402 },
    { token: CE_2400, price: 10.2, ts: 500, bid: 10, ask: 10.5 },
  ])

  const seeded = must(v)
  assert.equal(seeded.spot, 2401, 'the book survived the round trip through persistence')
  assert.deepEqual(rowOf(seeded, 2400).ce, { bid: 10, ask: 10.5, ltp: 10.2, asOf: 500 })

  v.onTick({ token: CE_2400, price: 12, ts: 9_000, bid: 12, ask: 12.5 })
  assert.deepEqual(rowOf(must(v), 2400).ce, { bid: 12, ask: 12.5, ltp: 12, asOf: 9_000 })
})

test('warm start never overwrites what the feed has already said', () => {
  const { v } = fixture()
  future(v, 2400, 2402, 2401, 1_000)
  v.onTick({ token: CE_2400, price: 12, ts: 9_000, bid: 12, ask: 12.5 })

  v.warmStart([{ token: CE_2400, price: 10.2, ts: 500, bid: 10, ask: 10.5 }])

  assert.deepEqual(rowOf(must(v), 2400).ce, { bid: 12, ask: 12.5, ltp: 12, asOf: 9_000 })
})

test('a seeded pair ages from the BOOK frame the snapshot recorded, not from the last print', () => {
  const { v } = fixture(false)
  v.warmStart([
    { token: FUT, price: 2405, ts: 500, bid: 2400, ask: 2402, bookTs: 400 },
    { token: CE_2400, price: 10.2, ts: 500, bid: 10, ask: 10.5, bookTs: 300 },
  ])
  assert.equal(rowOf(must(v), 2400).ce?.asOf, 300)
})

test('a snapshot row with no pair, or an unusable price, seeds no book', () => {
  const { v } = fixture(false)
  v.warmStart([
    { token: FUT, price: 2405, ts: 500, bid: 2400, ask: 2402 },
    { token: CE_2400, price: 10.2, ts: 500, bid: null, ask: null },
    { token: PE_2400, price: 0, ts: 500, bid: 1, ask: 2 },
  ])

  const s = must(v)
  assert.deepEqual(rowOf(s, 2400).ce, { bid: null, ask: null, ltp: 10.2, asOf: 500 })
  assert.equal(rowOf(s, 2400).pe, null, 'a zero price is the legacy 0.05 fill artefact, not a mark')
})

test('warm start is not a touch — nothing has come off the feed yet', () => {
  const { v } = fixture(false)
  v.warmStart([{ token: FUT, price: 2405, ts: 500, bid: 2400, ask: 2402 }])
  assert.notEqual(snapOf(v), null, 'the seed is enough to snap on')
  assert.equal(v.touchedSince(0), false)

  v.onTick({ token: FUT, price: 2406, ts: 1_000, bid: 2405, ask: 2407 })
  assert.equal(v.touchedSince(0), true)
})

// ---------------------------------------------------------- touchedSince

test('touchedSince answers off the ticks that actually landed', () => {
  const { v } = fixture()
  assert.equal(v.touchedSince(0), false, 'nothing has ever arrived')

  future(v, 2400, 2402, 2401, 5_000)
  assert.equal(v.touchedSince(4_999), true)
  assert.equal(v.touchedSince(5_000), false, 'a tick at the instant you last looked is one you saw')
  assert.equal(v.touchedSince(6_000), false)

  // An LTP-only tick IS the market moving, even though it changes no book.
  v.onTick({ token: CE_2400, price: 10.2, ts: 7_000 })
  assert.equal(v.touchedSince(6_000), true)
})
