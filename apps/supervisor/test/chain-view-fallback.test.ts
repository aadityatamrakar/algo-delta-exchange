/**
 * A BOOK THAT STOPS DECIDING IS WORSE THAN ONE DECIDING ON A PROXY.
 *
 * `snap()` returns `null` when the near-month future has no quote AT ALL, and
 * a null snap makes `EngineHost.#evaluateOnce` bail without a word
 * (`apps/supervisor/src/engine-host.ts:699-706`). For an index book whose whole
 * job is to react within seconds, that is an outage that looks like a quiet
 * market. A spot-times-carry forward is a known approximation — a few points
 * of basis error on a 24,000 index, which moves every greek by less than the
 * spread it is marked off; silence moves everything by 100%.
 *
 * The three failures these assertions exist for:
 *
 *   1. **Silence.** No future quote plus a known index spot used to be `null`.
 *      It is now a snapshot, and `syntheticForward` says so out loud, because a
 *      book deciding on a proxy must be a fact the operator can see rather than
 *      one they have to infer from the basis.
 *   2. **The fallback stealing a real forward.** `midOf` falls back to the
 *      print, so a genuinely ONE-SIDED future already snaps fine
 *      (`packages/desk-engine/src/marking.ts:132-135`). If the fallback fired
 *      for it too, the book would silently price a traded forward off an index
 *      level that is not the same number and never was.
 *   3. **An invented number.** No future quote AND no spot is still `null`.
 *      There is no third source, and a chain priced off a forward nobody
 *      published is worse than no chain — it decides, and it is wrong.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChainSnap, OptType } from '@algomaker/desk-engine'
import { ChainView, type ChainToken, type ChainViewDeps } from '../src/chain-view.ts'

const SYMBOL = 'NIFTY'
const EXPIRY = '2026-09-22'
const LOT = 65
const STEP = 50

/** 2026-09-15, 10:15 IST — a real market minute, well inside the session. */
const NOW = Date.parse('2026-09-15T10:15:00+05:30')

const FUT = 800
const CE_24000 = 301
const PE_24000 = 302
const CE_24050 = 303

/** The index itself, and the near-month carry over it. */
const CASH = 24_000
const CARRY = 1.0012
const FORWARD = 24_028.8 // CASH * CARRY, written out so the test states the answer

function opt(strike: number, optType: OptType, token: number): ChainToken {
  return { token, strike, optType, instrument: `NIFTY26922${String(strike)}${optType}` }
}

/**
 * A view over one NIFTY weekly, with whatever spot source the case is about.
 *
 * `snap()` IS THE DECLARATION — a token does not say which underlying it
 * belongs to — so this snaps once before returning, and every fixture's ticks
 * land on a chain the view has already admitted.
 */
function viewWith(
  src: {
    spotFor?: (symbol: string) => number | null
    carryFor?: (symbol: string) => number
  } = {},
  futureToken = FUT,
): ChainView {
  const deps: ChainViewDeps = {
    tokensFor: (symbol, expiry) =>
      symbol === SYMBOL && expiry === EXPIRY
        ? [opt(24_000, 'CE', CE_24000), opt(24_000, 'PE', PE_24000), opt(24_050, 'CE', CE_24050)]
        : [],
    futureToken: () => futureToken,
    ...src,
  }
  const v = new ChainView(deps)
  v.snap(SYMBOL, EXPIRY, LOT, STEP)
  return v
}

function snapOf(v: ChainView): ChainSnap | null {
  return v.snap(SYMBOL, EXPIRY, LOT, STEP)
}

/** The snapshot, or a failure that says the forward was missing. */
function must(v: ChainView): ChainSnap {
  const s = snapOf(v)
  assert.notEqual(s, null, 'expected a snapshot')
  return s as ChainSnap
}

// ------------------------------------------------- the forward is missing

test('snap falls back to spot x carry when the future has no quote at all', () => {
  const v = viewWith({ spotFor: () => CASH, carryFor: () => CARRY })
  // Only an option prints. The future was never subscribed, or has printed
  // neither a two-sided book nor an LTP all session.
  v.onTick({ token: CE_24000, price: 100, ts: NOW, bid: 99, ask: 101 })

  const s = must(v)
  assert.ok(Math.abs(s.spot - FORWARD) < 0.01, `spot was ${String(s.spot)}`)
  assert.equal(v.syntheticForward, true)
  // The rest of the snapshot is the ordinary one: the whole listed chain, and
  // an age taken from the newest quote in it.
  assert.deepEqual(
    s.strikes.map((r) => r.strike),
    [24_000, 24_050],
  )
  assert.equal(s.asOf, NOW)
})

test('the synthetic forward is a PRINT, not an invented two-sided book', () => {
  const v = viewWith({ spotFor: () => CASH, carryFor: () => CARRY })
  v.onTick({ token: CE_24000, price: 100, ts: NOW, bid: 99, ask: 101 })

  // A fabricated bid/ask would read downstream as a tradable forward with a
  // spread nobody quoted. There is no book here, and the quote says so.
  const s = must(v)
  assert.equal(s.future.bid, null)
  assert.equal(s.future.ask, null)
  assert.equal(s.future.ltp, s.spot, 'the print IS the forward it was priced at')
  assert.equal(s.future.asOf, NOW)
})

test('a synthetic forward on a view the feed has never touched is stamped 0, never "now"', () => {
  // `asOf` is the age of the basis (header §2). This class has no clock, and a
  // proxy forward built before the first tick of the day must not read fresh:
  // 0 ages to the whole epoch, which is exactly how stale it is.
  const v = viewWith({ spotFor: () => CASH, carryFor: () => CARRY })
  assert.equal(must(v).future.asOf, 0)
})

// ---------------------------------------------------- a real forward wins

test('a real future quote always wins over the fallback', () => {
  const v = viewWith({ spotFor: () => CASH, carryFor: () => CARRY })
  v.onTick({ token: FUT, price: 24_050, ts: NOW, bid: 24_049, ask: 24_051 })

  assert.equal(must(v).spot, 24_050)
  assert.equal(v.syntheticForward, false)
})

test('a ONE-SIDED future is not the fallback case — it still prices off its own print', () => {
  // `midOf` falls back to the LTP for a genuinely one-sided book, so this has
  // always snapped. Widening the fallback to cover it would replace a traded
  // forward (24,050) with an index proxy (24,028.8) that is a different number.
  const v = viewWith({ spotFor: () => CASH, carryFor: () => CARRY })
  v.onTick({ token: FUT, price: 24_050, ts: NOW })

  assert.equal(must(v).spot, 24_050)
  assert.equal(v.syntheticForward, false)
})

// --------------------------------------------------- nothing to price off

test('no future quote AND no spot still returns null — never a made-up number', () => {
  const v = viewWith({ spotFor: () => null, carryFor: () => CARRY })
  v.onTick({ token: CE_24000, price: 100, ts: NOW, bid: 99, ask: 101 })

  assert.equal(snapOf(v), null)
  assert.equal(v.syntheticForward, false, 'a snapshot that never happened used no proxy')
})

test('a view given no spot source at all behaves exactly as it did before the fallback existed', () => {
  // This is the wiring `main.ts` ships until the index-spot feed lands. It is
  // also every OTHER caller of this class, and none of their books may start
  // deciding off a proxy because a second book wanted one.
  const v = viewWith()
  v.onTick({ token: CE_24000, price: 100, ts: NOW, bid: 99, ask: 101 })

  assert.equal(snapOf(v), null)
  assert.equal(v.syntheticForward, false)
})

test('a chain whose master lists no future can still be priced off the index', () => {
  // `futureToken` answering 0 is the master saying "no such contract". That is
  // the same absence as an unquoted one, and the same proxy answers it.
  const v = viewWith({ spotFor: () => CASH, carryFor: () => CARRY }, 0)
  v.onTick({ token: CE_24000, price: 100, ts: NOW, bid: 99, ask: 101 })

  assert.ok(Math.abs(must(v).spot - FORWARD) < 0.01)
  assert.equal(v.syntheticForward, true)
})

// ------------------------------------------------------------- the flag

test('syntheticForward reports the LAST snap, and never stays true once the future prints', () => {
  // The flag is read after a snap to stamp the decision that came out of it.
  // Left latched, it would mark every later decision of the session as a proxy
  // decision — and an operator who stops believing the flag has no flag.
  const v = viewWith({ spotFor: () => CASH, carryFor: () => CARRY })
  v.onTick({ token: CE_24000, price: 100, ts: NOW, bid: 99, ask: 101 })
  must(v)
  assert.equal(v.syntheticForward, true)

  v.onTick({ token: FUT, price: 24_050, ts: NOW + 1_000, bid: 24_049, ask: 24_051 })
  must(v)
  assert.equal(v.syntheticForward, false)
})

test('a spot source that answers with something that is not a price is refused', () => {
  // The same refusal `onTick` makes at ingest. A NaN forward throws nowhere —
  // it turns every greek on the chain into NaN, and the book sizes off that.
  for (const bad of [Number.NaN, 0, -24_000, Number.POSITIVE_INFINITY]) {
    const v = viewWith({ spotFor: () => bad, carryFor: () => CARRY })
    assert.equal(snapOf(v), null, `spot ${String(bad)} is not a forward`)
  }
  const v = viewWith({ spotFor: () => CASH, carryFor: () => Number.NaN })
  assert.equal(snapOf(v), null, 'nor is a carry that is not a number')
})
