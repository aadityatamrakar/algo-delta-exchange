/**
 * A WEEKLY PRICED OFF ITS OWN FORWARD — the chain view's half of six-playbooks
 * spec F1.
 *
 * `ChainSnap.spot` is the forward every ATM, delta and band strike is picked
 * off, and it was the near-month FUTURE's mid for every book. A weekly does not
 * expire with the monthly: its own forward sat a median 308 points below the
 * future on SENSEX. A snap asked for `forward: 'parity'` reads the chain's own
 * forward instead, and the failures these assertions exist for are all quiet:
 *
 *   1. **The wrong forward kept.** A parity snap whose `spot` is still the
 *      future's mid looks exactly like a working one. The board below is priced
 *      at one forward and the future quoted 300 points above it, so the two
 *      cannot be mistaken for each other.
 *   2. **A degenerate chain read as a forward** (review focus 5). Two usable
 *      strikes, a stale chain, or a read the sanity band refuses must fall back
 *      to the index carried over the contract's tenor — never to a guess.
 *   3. **An invented fallback.** With no index level there is nothing to read
 *      parity around or to carry, and the snap is today's: the future's mid.
 *   4. **A recenter book repriced.** A snap with no options is the snap this
 *      view has always taken, to the byte — the recenter parity suites are
 *      pinned against it.
 *
 * No Mongo, no clock: every quote is a literal off `b76Price`, so every forward
 * below is derived rather than asserted into existence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import { RISK_FREE, carryForward, yearFrac, type ChainSnap, type OptType } from '@algomaker/desk-engine'
import { ChainView, type ChainToken, type ChainViewDeps, type MdTick } from '../src/chain-view.ts'

const SYMBOL = 'NIFTY'
/** 2026-09-15, a Tuesday and a trading day, 10:15 IST. */
const DATE = '2026-09-15'
const MINUTE = 615
const NOW = Date.parse('2026-09-15T10:15:00+05:30')
/** The following Tuesday's weekly. */
const EXPIRY = '2026-09-22'
const LOT = 65
const STEP = 50

/** The cash index, which the parity read is taken around. */
const INDEX = 24_000
/** The weekly's OWN forward: twenty points of carry above the index. */
const FWD = 24_020
/** The near-month future, quoted 300 points above the weekly's forward. */
const FUTURE_MID = FWD + 300

const FUT = 900
const LADDER = Array.from({ length: 13 }, (_, i) => 23_700 + i * STEP)
const tokenOf = (strike: number, optType: OptType): number => strike * 10 + (optType === 'CE' ? 1 : 2)

/** The tenor `parityForward` and `carryForward` price at — the desk's own. */
const T = yearFrac(DATE, EXPIRY, MINUTE)
const VOL = 0.12

const priceAt = (fwd: number, strike: number, optType: OptType): number =>
  b76Price({ future: fwd, strike, t: T, vol: VOL, rate: RISK_FREE, type: optType })

/** The index carried over the contract's tenor: what `'index-carry'` must equal. */
const CARRIED = carryForward(INDEX, DATE, EXPIRY, MINUTE)

/** The parity snap's options: the host's clock at snap time. */
const PARITY = { forward: 'parity', nowMs: NOW, dateIst: DATE, minuteOfDay: MINUTE } as const

/** A view over the NIFTY weekly. `spotFor: null` builds one with no index dep at all. */
function view(spotFor: ((symbol: string) => number | null) | null = () => INDEX): ChainView {
  const deps: ChainViewDeps = {
    tokensFor: (symbol, expiry): ChainToken[] =>
      symbol !== SYMBOL || expiry !== EXPIRY
        ? []
        : LADDER.flatMap((strike) =>
            (['CE', 'PE'] as const).map(
              (optType): ChainToken => ({
                token: tokenOf(strike, optType),
                strike,
                optType,
                instrument: `NIFTY26922${String(strike)}${optType}`,
              }),
            ),
          ),
    futureToken: () => FUT,
    ...(spotFor === null ? {} : { spotFor }),
    // `main.ts`'s own: a flat 1, so the §5 proxy is the bare index level.
    carryFor: () => 1,
  }
  const v = new ChainView(deps)
  // The snap IS the declaration: without it every tick below is dropped.
  v.snap(SYMBOL, EXPIRY, LOT, STEP)
  return v
}

/**
 * The board, priced at `fwd` and quoted one rupee wide at `ts`, with `skip`
 * naming the wings that never print. Deliberately WITHOUT the future: the
 * cases that want one say so.
 */
function board(v: ChainView, fwd = FWD, ts = NOW, skip: (k: number, t: OptType) => boolean = () => false): void {
  for (const strike of LADDER) {
    for (const optType of ['CE', 'PE'] as const) {
      if (skip(strike, optType)) continue
      const mid = priceAt(fwd, strike, optType)
      const tick: MdTick = { token: tokenOf(strike, optType), price: mid, ts, bid: mid - 0.5, ask: mid + 0.5 }
      v.onTick(tick)
    }
  }
}

function quoteFuture(v: ChainView, mid = FUTURE_MID, ts = NOW): void {
  v.onTick({ token: FUT, price: mid, ts, bid: mid - 0.5, ask: mid + 0.5 })
}

function must(s: ChainSnap | null): ChainSnap {
  assert.notEqual(s, null, 'expected a snapshot')
  return s as ChainSnap
}

// ─────────────────────────────────────────────────── 1. the chain's own forward

test('a parity snap prices spot off the chain`s own forward, not the future 300 points above it', () => {
  const v = view()
  board(v)
  quoteFuture(v)

  const s = must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY))
  assert.ok(Math.abs(s.spot - FWD) < 0.5, `spot ${String(s.spot)}, the board is priced at ${String(FWD)}`)
  assert.equal(v.forwardSource, 'parity')
  // ONLY `spot` moves. The future is still what was quoted — nothing in the
  // engine reads it, and a fabricated one would be a quote nobody made.
  assert.equal(s.future.bid, FUTURE_MID - 0.5)
  assert.equal(s.future.ask, FUTURE_MID + 0.5)
  // And the rest of the snapshot is the one a plain snap returns.
  const plain = must(v.snap(SYMBOL, EXPIRY, LOT, STEP))
  assert.deepEqual(s.strikes, plain.strikes)
  assert.equal(s.asOf, plain.asOf)
})

test('the parity read needs no future at all — the weekly`s own options carry it', () => {
  // The §5 case: the future has never quoted. Without the request this is the
  // proxy (index x 1); asked for parity, the chain's own forward wins, and the
  // snap is not "priced off the proxy" any more.
  const v = view()
  board(v)

  const proxy = must(v.snap(SYMBOL, EXPIRY, LOT, STEP))
  assert.equal(proxy.spot, INDEX)
  assert.equal(v.forwardSource, 'proxy')
  assert.equal(v.syntheticForward, true)

  const s = must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY))
  assert.ok(Math.abs(s.spot - FWD) < 0.5, `spot ${String(s.spot)}`)
  assert.equal(v.forwardSource, 'parity')
  assert.equal(v.syntheticForward, false, 'spot came off the chain, not off the proxy')
})

// ───────────────────────────────────────── 2. a degenerate chain (review focus 5)

test('two usable strikes are not a median — the forward is the index carried over the tenor', () => {
  // The six strikes nearest 24,000 are 23,850…24,100. Four of them never print
  // a call, so two strikes survive: below the three a median is taken over.
  const dark = new Set([23_850, 23_900, 24_050, 24_100])
  const v = view()
  board(v, FWD, NOW, (k, t) => t === 'CE' && dark.has(k))
  quoteFuture(v)

  const s = must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY))
  assert.equal(s.spot, CARRIED)
  assert.equal(v.forwardSource, 'index-carry')
})

test('a chain whose quotes are past ten seconds old is not read — the index carries it', () => {
  const v = view()
  board(v)
  quoteFuture(v)

  // The same board, asked about eleven seconds later: every wing has aged out.
  const s = must(v.snap(SYMBOL, EXPIRY, LOT, STEP, { ...PARITY, nowMs: NOW + 11_000 }))
  assert.equal(s.spot, CARRIED)
  assert.equal(v.forwardSource, 'index-carry')
})

test('a parity read the sanity band refuses falls back to index x carry, never to the read', () => {
  // The options say 24,300 while the index says 24,000: 1.25% apart, past
  // max(0.6% x index, 2 x step) = 144. That is a broken quote set, not a basis.
  const v = view()
  board(v, INDEX + 300)
  quoteFuture(v)

  const s = must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY))
  assert.equal(s.spot, CARRIED)
  assert.equal(v.forwardSource, 'index-carry')
})

// ───────────────────────────────────────────────────── 3. no index level at all

test('no index level: a parity request is today`s snap — the future`s mid, said as future', () => {
  const v = view(() => null)
  board(v)
  quoteFuture(v)

  const s = must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY))
  assert.equal(s.spot, FUTURE_MID)
  assert.equal(v.forwardSource, 'future')
})

test('no index level and no future quote is still no snapshot — and no source', () => {
  const v = view(() => null)
  board(v)

  assert.equal(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY), null)
  assert.equal(v.forwardSource, null)
})

test('a view built with no index source at all prices a parity request off the future', () => {
  const v = view(null)
  board(v)
  quoteFuture(v)

  assert.equal(must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY)).spot, FUTURE_MID)
  assert.equal(v.forwardSource, 'future')
})

test('a parity request without the clock cannot age a wing — it is today`s snap', () => {
  // A caller bug, not a market state: the view has no clock of its own, and a
  // read it cannot age is a read it does not take.
  const v = view()
  board(v)
  quoteFuture(v)

  assert.equal(must(v.snap(SYMBOL, EXPIRY, LOT, STEP, { forward: 'parity' })).spot, FUTURE_MID)
  assert.equal(v.forwardSource, 'future')
})

// ───────────────────────────────────────── 4. a snap nobody asked to reprice

test('no options is today`s snap to the byte — the future`s mid, even beside a parity-clean chain', () => {
  const v = view()
  board(v)
  quoteFuture(v)

  const plain = must(v.snap(SYMBOL, EXPIRY, LOT, STEP))
  assert.equal(plain.spot, FUTURE_MID)
  assert.equal(v.forwardSource, 'future')
  // `forward: 'future'` with the clock is the same snapshot, field for field:
  // the clock is read by the parity path and by nothing else.
  assert.deepEqual(
    v.snap(SYMBOL, EXPIRY, LOT, STEP, { forward: 'future', nowMs: NOW, dateIst: DATE, minuteOfDay: MINUTE }),
    plain,
  )
  assert.deepEqual(v.snap(SYMBOL, EXPIRY, LOT, STEP, {}), plain)
})

test('forwardSource describes the LAST snap, and a snap that returned nothing has none', () => {
  const fresh = new ChainView({ tokensFor: () => [], futureToken: () => 0 })
  assert.equal(fresh.forwardSource, null, 'nothing before the first snapshot')

  let index: number | null = INDEX
  const v = view(() => index)
  board(v) // no future quote: the index is the only thing to read the chain around
  must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY))
  assert.equal(v.forwardSource, 'parity')

  // The index goes quiet: no future, no level, no snapshot — and the previous
  // call's source must not survive to stamp the next decision.
  index = null
  assert.equal(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY), null)
  assert.equal(v.forwardSource, null)

  quoteFuture(v)
  must(v.snap(SYMBOL, EXPIRY, LOT, STEP, PARITY))
  assert.equal(v.forwardSource, 'future', 'the next snap says what priced IT')
})
