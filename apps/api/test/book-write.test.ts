/**
 * The lost-race re-fold — what happens to a ROUTED fill when somebody else's
 * write wins.
 *
 * Two money-path invariants, both of them holes the Tier-2 review found:
 *
 *  1. A routed fill the re-fold cannot place is DROPPED. The order is out at the
 *     broker and nothing can un-route it, so the book and the account now
 *     disagree and the only honest response is to say so at ERROR, naming the
 *     fill. Silence here is a routed EXIT vanishing from the book.
 *  2. A REDUCING compensation must re-derive its cap against the FRESH legs.
 *     Its size was capped against the book we read; the winner has since moved
 *     that book, and re-applying the full quantity walks `applyRoutedFill`
 *     through zero and APPENDS an opposite leg — a reconciler inventing
 *     exposure, which is the one thing it may never do.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  refoldOnConflict,
  refoldRoutedFills,
  type BookDocLike,
  type BookKeyLike,
  type BookWriteStore,
  type RefoldFill,
} from '../src/book-write.ts'
import type { BridgeLeg, DeskMode } from '../src/contract.ts'

// ------------------------------------------------------------------ fixtures

const SYMBOL = 'BANKNIFTY'
const EXPIRY = '2026-08-27'
const TAG = 'DESK_BANKNIFTY'
const PE = 'BANKNIFTY26AUG56000PE'
const NOW = Date.UTC(2026, 7, 14, 6, 31)

const KEY: BookKeyLike = { tag: TAG, mode: 'live' as DeskMode, symbol: SYMBOL, expiry: EXPIRY }

function leg(over: Partial<BridgeLeg> = {}): BridgeLeg {
  return {
    deskTag: 'L1',
    instrument: {
      tradingsymbol: PE,
      exchange: 'NFO',
      instrumentToken: 1,
      lotSize: 35,
      tickSize: 0.05,
    },
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike: 56_000,
    type: 'PE',
    side: 'Sell',
    qty: -500,
    entryPrice: 100,
    openedTs: NOW - 60_000,
    ...over,
  }
}

function fill(over: Partial<RefoldFill> = {}): RefoldFill {
  return {
    op: 'close',
    deskTag: 'L1',
    tradingsymbol: PE,
    side: 'Buy',
    qty: 500,
    price: 100,
    ts: NOW,
    ...over,
  }
}

class FakeStore implements BookWriteStore {
  doc: BookDocLike | null = null
  /** Runs INSIDE `saveBook`, before the compare — the window a winner lands in. */
  beforeSave: (() => void) | null = null

  async bookDoc(): Promise<BookDocLike | null> {
    return this.doc
  }
  async saveBook(
    key: BookKeyLike,
    legs: readonly BridgeLeg[],
    nowMs: number,
    expectedUpdatedAt?: number | null,
    correctionNonce?: string,
  ): Promise<'ok' | 'conflict'> {
    this.beforeSave?.()
    if (expectedUpdatedAt === null) {
      if (this.doc !== null) return 'conflict'
    } else if (expectedUpdatedAt !== undefined && this.doc?.updatedAt !== expectedUpdatedAt) {
      return 'conflict'
    }
    // The nonce lands in the SAME write as the legs — see `store.saveBook`.
    const applied = [...(this.doc?.appliedCorrections ?? [])]
    if (correctionNonce !== undefined) applied.push(correctionNonce)
    this.doc = {
      symbol: key.symbol,
      expiry: key.expiry,
      legs,
      updatedAt: Math.max(nowMs, (this.doc?.updatedAt ?? 0) + 1),
      appliedCorrections: applied,
    }
    return 'ok'
  }
}

// ------------------------------------------------- a dropped fill is REPORTED

test('a routed fill the re-fold cannot place is reported, not swallowed', () => {
  // Nothing anywhere describes this contract and the caller may not create one.
  const out = refoldRoutedFills({
    legs: [],
    routedFills: [fill()],
    views: [[], []],
    mayCreate: false,
    nowMs: NOW,
  })

  assert.deepEqual(out.legs, [], 'no leg invented for a contract nothing holds')
  assert.equal(out.outcomes.length, 1, 'one outcome per routed fill, always')
  assert.equal(out.outcomes[0]?.applied, 0)
  assert.equal(out.outcomes[0]?.skipped, true)
  assert.equal(out.outcomes[0]?.shortfall, 500)
})

test('refoldOnConflict names every dropped ROUTED fill at ERROR', async () => {
  const store = new FakeStore()
  store.doc = { symbol: SYMBOL, expiry: EXPIRY, legs: [], updatedAt: 10 }
  const logs: string[] = []

  const result = await refoldOnConflict({
    store,
    key: KEY,
    // A routed EXIT on a contract the winner's book no longer describes.
    routedFills: [fill({ side: 'Buy', qty: 300 })],
    nextBook: [],
    priorBook: [],
    mayCreate: false,
    nowMs: NOW,
    log: (m) => logs.push(m),
  })

  assert.equal(result.status, 'ok-with-skips', "the write landed, but NOT all of it")
  const said = logs.join('\n')
  assert.match(said, /ROUTED fill could NOT be re-folded after losing the race/)
  assert.match(said, /book and broker may now disagree — check positions/)
  assert.match(said, new RegExp(TAG))
  assert.match(said, new RegExp(PE))
  assert.match(said, /Buy/)
  assert.match(said, /300/)
})

test('a re-fold that places everything reports plain ok and logs nothing', async () => {
  const store = new FakeStore()
  store.doc = { symbol: SYMBOL, expiry: EXPIRY, legs: [leg()], updatedAt: 10 }
  const logs: string[] = []

  const result = await refoldOnConflict({
    store,
    key: KEY,
    routedFills: [fill({ side: 'Buy', qty: 500 })],
    nextBook: [],
    priorBook: [leg()],
    mayCreate: false,
    nowMs: NOW,
    log: (m) => logs.push(m),
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.outcomes[0]?.applied, 500)
  assert.deepEqual(store.doc?.legs, [], 'the exit landed on the winner’s legs')
  assert.deepEqual(logs, [])
})

// ------------------------------------------------------ reduceOnly semantics

test('a reduceOnly fill consumes only what the FRESH legs hold', () => {
  // The winner already took 300 off the leg. The compensation was sized against
  // the stale book, so its 500 is now more than exists.
  const out = refoldRoutedFills({
    legs: [leg({ qty: -200 })],
    routedFills: [fill({ side: 'Buy', qty: 500, reduceOnly: true })],
    views: [[], [leg()]],
    mayCreate: false,
    nowMs: NOW,
  })

  assert.deepEqual(out.legs, [], 'the 200 that was left is gone')
  assert.equal(out.outcomes[0]?.applied, 200, 'the cap is re-derived at APPLY time')
  assert.equal(out.outcomes[0]?.shortfall, 300)
  assert.equal(out.outcomes[0]?.skipped, false)
})

test('a reduceOnly fill NEVER appends a leg by crossing through zero', () => {
  const out = refoldRoutedFills({
    legs: [leg({ qty: -200 })],
    routedFills: [fill({ side: 'Buy', qty: 500, reduceOnly: true })],
    // `mayCreate` is irrelevant to a reduceOnly fill: it may not grow anything.
    views: [[], [leg()]],
    mayCreate: true,
    nowMs: NOW,
  })

  assert.equal(out.legs.length, 0, 'a +300 leg here is a phantom position')
  assert.equal(
    out.legs.filter((l) => l.qty > 0).length,
    0,
    'a correction may only REDUCE — never open the other side',
  )
})

test('WITHOUT reduceOnly the same fill crosses zero — which is why it exists', () => {
  const out = refoldRoutedFills({
    legs: [leg({ qty: -200 })],
    routedFills: [fill({ side: 'Buy', qty: 500 })],
    views: [[], [leg()]],
    mayCreate: true,
    nowMs: NOW,
  })

  assert.equal(out.legs.length, 1)
  assert.equal(out.legs[0]?.qty, 300, 'the cross-through-zero leg the reconciler must never book')
})

test('a reduceOnly fill with nothing left to reduce is honest, not alarming', async () => {
  const store = new FakeStore()
  // The winner emptied the leg outright.
  store.doc = { symbol: SYMBOL, expiry: EXPIRY, legs: [], updatedAt: 10 }
  const logs: string[] = []

  const result = await refoldOnConflict({
    store,
    key: KEY,
    routedFills: [fill({ side: 'Buy', qty: 500, reduceOnly: true })],
    nextBook: [],
    priorBook: [leg()],
    mayCreate: false,
    nowMs: NOW,
    log: (m) => logs.push(m),
  })

  assert.equal(result.outcomes[0]?.applied, 0)
  assert.equal(result.outcomes[0]?.skipped, true)
  assert.equal(
    result.status,
    'ok',
    'a compensation with nothing left to reduce is the winner having done the work',
  )
  assert.deepEqual(logs, [], 'and it is NOT the lost-routed-fill alarm')
})

// ------------------------------------------------------------- the row is gone

test('a book deleted under the re-fold is reported, never resurrected', async () => {
  const store = new FakeStore()
  const logs: string[] = []
  const result = await refoldOnConflict({
    store,
    key: KEY,
    routedFills: [fill()],
    nextBook: [],
    priorBook: [leg()],
    mayCreate: false,
    nowMs: NOW,
    log: (m) => logs.push(m),
  })

  assert.equal(result.status, 'gone')
  assert.equal(store.doc, null, 'a deleted book stays deleted')
  assert.match(logs.join('\n'), /no longer exists/)
})

test('a second lost race is loud and reports lost', async () => {
  const store = new FakeStore()
  store.doc = { symbol: SYMBOL, expiry: EXPIRY, legs: [leg()], updatedAt: 10 }
  // Somebody wins the second race too.
  store.beforeSave = () => {
    store.doc = { ...(store.doc as BookDocLike), updatedAt: (store.doc?.updatedAt ?? 0) + 1 }
  }
  const logs: string[] = []

  const result = await refoldOnConflict({
    store,
    key: KEY,
    routedFills: [fill()],
    nextBook: [],
    priorBook: [leg()],
    mayCreate: false,
    nowMs: NOW,
    log: (m) => logs.push(m),
  })

  assert.equal(result.status, 'lost')
  assert.match(logs.join('\n'), /lost two races/)
})

// -------------------------------------------------------------- the fold nonce

/**
 * THE CRASH WINDOW THE NONCE CLOSES (WP-L, the Tier-2 verifier's residual).
 *
 * The reconciler folds its compensation into `desk-books` and then stamps
 * `foldDone` on `desk-decisions`. Two collections, two writes: a process that
 * died in between left a book that HAD been folded and a record that said it
 * had not, and the next pass folded the same compensation again. For a refused
 * CLOSE — the one regime that may CREATE a leg — that is a repair inventing the
 * position it exists to remove.
 *
 * So the proof travels WITH the fold: `appliedCorrections` is appended in the
 * same `saveBook` write as the legs. One document, one `updateOne`, no window.
 * The retry path has to thread it too, or a fold that lands on the second
 * attempt lands without its receipt and the next pass repeats it.
 */
test('refoldOnConflict threads the nonce into the retry write', async () => {
  const store = new FakeStore()
  store.doc = { symbol: SYMBOL, expiry: EXPIRY, legs: [leg()], updatedAt: 10 }

  const result = await refoldOnConflict({
    store,
    key: KEY,
    routedFills: [fill({ side: 'Buy', qty: 500 })],
    nextBook: [],
    priorBook: [leg()],
    mayCreate: false,
    nowMs: NOW,
    nonce: 'd1#0',
    log: () => undefined,
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(
    store.doc?.appliedCorrections,
    ['d1#0'],
    'a fold with no receipt is a fold the next pass repeats',
  )
})

test('a re-fold that lands NOTHING still records no receipt it did not earn', async () => {
  const store = new FakeStore()
  // The winner emptied the leg: the reduceOnly cap applies zero.
  store.doc = { symbol: SYMBOL, expiry: EXPIRY, legs: [], updatedAt: 10 }

  await refoldOnConflict({
    store,
    key: KEY,
    routedFills: [fill({ side: 'Buy', qty: 500, reduceOnly: true })],
    nextBook: [],
    priorBook: [leg()],
    mayCreate: false,
    nowMs: NOW,
    nonce: 'd1#0',
    log: () => undefined,
  })

  // The write DID land (the legs are the winner's, unchanged), and the nonce
  // rides with it: the compensation is finished either way — there was nothing
  // left to apply — and the next pass must not try to apply it again.
  assert.deepEqual(store.doc?.appliedCorrections, ['d1#0'])
})

test('a LOST re-fold writes no nonce at all', async () => {
  const store = new FakeStore()
  store.doc = { symbol: SYMBOL, expiry: EXPIRY, legs: [leg()], updatedAt: 10 }
  store.beforeSave = () => {
    store.doc = { ...(store.doc as BookDocLike), updatedAt: (store.doc?.updatedAt ?? 0) + 1 }
  }

  const result = await refoldOnConflict({
    store,
    key: KEY,
    routedFills: [fill()],
    nextBook: [],
    priorBook: [leg()],
    mayCreate: false,
    nowMs: NOW,
    nonce: 'd1#0',
    log: () => undefined,
  })

  assert.equal(result.status, 'lost')
  assert.equal(
    (store.doc?.appliedCorrections ?? []).includes('d1#0'),
    false,
    'a receipt for a fold that never landed would abandon it forever',
  )
})
