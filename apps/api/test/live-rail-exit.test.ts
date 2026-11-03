/**
 * The LIVE rail's own reduce-only exemption (spec §9).
 *
 * "Switching a tag off blocks new exposure and never blocks an exit" is a rule
 * with TWO enforcers, and until the D9 cutover only one of them knew it.
 * `gateStrategy` exempted a reduce-only package from a switched-off row; then
 * `LiveRail.route` re-read the very same switch on the way to the wire with no
 * exemption of its own, and refused. A switched-off live book could not be
 * exited by the desk at all — every closing order came back as a route error.
 *
 * These tests pin BOTH directions, because a rail that let everything through
 * would pass a one-sided suite: an open is still refused, a close now routes,
 * and a resize that GROWS is refused even though it names a leg the book holds.
 *
 * NO MONGO. The rail reads one document and writes one; a fake collection is a
 * more precise statement of what it must read than a live database is, and it
 * lets the fail-closed cases (a read that throws, a duplicated desk tag) be
 * asserted at all.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LiveRail, LiveRailBlocked, type RouteContext } from '../src/rail.ts'
import { COLLECTIONS, type Database } from '../src/store.ts'
import type { Fill } from '../src/contract.ts'

const TAG = 'BHEL-2026-08-25-recenter-r'
const SYMBOL = 'BHEL26AUG420CE'

/** One stored leg, exactly as `applyActions` writes it: qty SIGNED, short negative. */
function leg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deskTag: 'CE420#0',
    instrument: { tradingsymbol: SYMBOL, instrumentToken: 42001, exchange: 'NFO', tickSize: 0.05 },
    underlying: 'BHEL',
    expiry: '2026-08-25',
    strike: 420,
    type: 'CE',
    side: 'Sell',
    qty: -13125,
    entryPrice: 12,
    openedTs: 1,
    ...over,
  }
}

interface Db {
  readonly db: Database
  /** Every document the rail wrote. Empty means it refused. */
  readonly routed: Record<string, unknown>[]
  /** Every filter the rail asked the BOOK collection with, in order. */
  readonly asked: Record<string, unknown>[]
}

/**
 * THE FAKE ANSWERS THE FILTER, it does not ignore it — and that is the point of
 * `books`.
 *
 * A store that hands back the same document whatever it is asked would let
 * every test below pass against a rail that read the PAPER book, or another
 * tag's book, to authorise a LIVE order. The queries are recorded in `asked`
 * and asserted, and `books` is keyed by `{tag, mode}` so a filter that does not
 * match returns null exactly as Mongo would.
 */
function db(
  books: Record<string, Record<string, unknown>>,
  opts: { throws?: boolean } = {},
): Db {
  const routed: Record<string, unknown>[] = []
  const asked: Record<string, unknown>[] = []
  const fake = {
    collection(name: string) {
      return {
        async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
          if (name !== COLLECTIONS.books) return null
          asked.push(filter)
          if (opts.throws === true) throw new Error('mongo is down')
          return books[`${String(filter['tag'])}|${String(filter['mode'])}`] ?? null
        },
        async insertOne(doc: Record<string, unknown>): Promise<void> {
          routed.push(doc)
        },
      }
    },
  }
  return { db: fake as unknown as Database, routed, asked }
}

/** The live book for `TAG`, in the shape the fake is keyed by. */
const liveBook = (legs: unknown[]): Record<string, Record<string, unknown>> => ({
  [`${TAG}|live`]: { tag: TAG, mode: 'live', legs },
})

const ctx: RouteContext = {
  tag: TAG,
  underlying: 'BHEL',
  instrument: { tradingsymbol: SYMBOL, instrumentToken: 42001, exchange: 'NFO', tickSize: 0.05, lotSize: 2625 },
  nowMs: Date.UTC(2026, 7, 22, 5, 0),
  clientOrderId: 'd-1#0',
}

/** The fill `applyActions` emits for a full close of the leg above. */
const close: Fill = {
  op: 'close', deskTag: 'CE420#0', tradingsymbol: SYMBOL, side: 'Buy', qty: 13125, price: 11, ts: 1,
}
/** An OPEN names a tag the book does not hold — always new exposure. */
const open: Fill = {
  op: 'open', deskTag: 'PE415#1', tradingsymbol: 'BHEL26AUG415PE', side: 'Sell', qty: 13125, price: 11, ts: 1,
}

async function refusal(rail: LiveRail, fill: Fill): Promise<Error | null> {
  try {
    await rail.route(fill, ctx)
    return null
  } catch (err) {
    return err as Error
  }
}

// ------------------------------------------------------- the two directions

test('a switched-off tag can still CLOSE what it holds', async () => {
  const h = db(liveBook([leg()]))
  await new LiveRail(h.db, []).route(close, ctx)
  assert.equal(h.routed.length, 1, 'the exit reaches the wire')
  assert.equal(h.routed[0]?.['tradingsymbol'], SYMBOL)
  assert.equal(h.routed[0]?.['transaction_type'], 'BUY')
  // THE QUERY ITSELF, because a rail that authorised a live order off some
  // OTHER book's legs would satisfy every other assertion in this file.
  assert.deepEqual(h.asked, [{ tag: TAG, mode: 'live' }])
})

test('a switched-off tag still cannot OPEN', async () => {
  const h = db(liveBook([leg()]))
  const err = await refusal(new LiveRail(h.db, []), open)
  assert.ok(err instanceof LiveRailBlocked, 'an open must be refused')
  assert.match(err.message, /ADD exposure/)
  assert.equal(h.routed.length, 0, 'nothing was written')
})

test('a resize that GROWS the leg is refused; one that SHRINKS it routes', async () => {
  // Both name a leg the book holds. The difference is the side the delta
  // trades on — `applyActions` sells more of a short to grow it and buys some
  // back to shrink it — which is the whole of the test the rail applies.
  const grow: Fill = {
    op: 'resize', deskTag: 'CE420#0', tradingsymbol: SYMBOL, side: 'Sell', qty: 2625, price: 12, ts: 1,
  }
  const shrink: Fill = { ...grow, side: 'Buy' }

  const g = db(liveBook([leg()]))
  const err = await refusal(new LiveRail(g.db, []), grow)
  assert.ok(err instanceof LiveRailBlocked, 'growing a leg is new exposure')
  assert.equal(g.routed.length, 0)

  const s = db(liveBook([leg()]))
  await new LiveRail(s.db, []).route(shrink, ctx)
  assert.equal(s.routed.length, 1, 'shrinking is an exit')
})

test('a tag switched ON routes either way, and never reads the book', async () => {
  // The allowlist short-circuits: an enabled tag must not pay a Mongo read per
  // order, and must not be able to be refused by a book that cannot be read.
  const h = db({}, { throws: true })
  const rail = new LiveRail(h.db, [TAG])
  await rail.route(open, ctx)
  await rail.route(close, ctx)
  assert.equal(h.routed.length, 2)
  assert.deepEqual(h.asked, [], 'an enabled tag pays no read at all')
})

// --------------------------------------------- it reads the LIVE book, only

/**
 * THE RAIL AUTHORISES A LIVE ORDER OFF THE LIVE BOOK, and nothing else.
 *
 * Paper and live are two ledgers on one tag, and the paper one is the easier of
 * the two to arrange: a rehearsal opens whatever it likes there without a
 * password, without the live switch, without touching real money. If this read
 * were keyed on the tag alone, a paper leg would be a permission slip for a
 * REAL order on a book the operator had deliberately switched off.
 */
test('a PAPER book holding the leg does NOT authorise the live order', async () => {
  const h = db({ [`${TAG}|paper`]: { tag: TAG, mode: 'paper', legs: [leg()] } })
  const err = await refusal(new LiveRail(h.db, []), close)
  assert.ok(err instanceof LiveRailBlocked, 'the live book holds nothing; the exit has nothing to exit')
  assert.equal(h.routed.length, 0)
  assert.deepEqual(h.asked, [{ tag: TAG, mode: 'live' }], 'and it asked for the LIVE book')
})

test("ANOTHER tag's live book does not authorise this tag's order", async () => {
  const h = db({ [`OTHER_TAG|live`]: { tag: 'OTHER_TAG', mode: 'live', legs: [leg()] } })
  const err = await refusal(new LiveRail(h.db, []), close)
  assert.ok(err instanceof LiveRailBlocked)
  assert.equal(h.routed.length, 0)
})

// ------------------------------------------------------------- fail closed

test('an order LARGER than the leg it names is refused — it would flip the position', async () => {
  const tooBig: Fill = { ...close, qty: 26250 }
  const h = db(liveBook([leg()]))
  const err = await refusal(new LiveRail(h.db, []), tooBig)
  assert.ok(err instanceof LiveRailBlocked)
  assert.equal(h.routed.length, 0)
})

test('no book, no leg, and a duplicated desk tag all refuse', async () => {
  for (const [what, books] of [
    ['no book document at all', {}],
    ['a book with no legs array', { [`${TAG}|live`]: { tag: TAG, mode: 'live' } }],
    ['a book that does not hold this tag', liveBook([leg({ deskTag: 'PE415#1' })])],
    // Ambiguous: which of the two is this order reducing? Neither answer is
    // one the rail may guess at, on the rail that spends real money.
    ['two legs sharing the desk tag', liveBook([leg(), leg()])],
    ['a leg with an unreadable quantity', liveBook([leg({ qty: 'lots' })])],
    ['a leg with no quantity at all', liveBook([leg({ qty: 0 })])],
  ] as const) {
    const h = db(books as Record<string, Record<string, unknown>>)
    const err = await refusal(new LiveRail(h.db, []), close)
    assert.ok(err instanceof LiveRailBlocked, `${what}: must refuse`)
    assert.equal(h.routed.length, 0, `${what}: nothing written`)
  }
})

test('a leg whose tag names a DIFFERENT contract refuses', async () => {
  // The desk tag matches and the direction matches, but the book's leg is a
  // different option. Routing on that would place an order sized off a
  // position this fill is not trading.
  const h = db(
    liveBook([leg({ instrument: { tradingsymbol: 'BHEL26AUG430CE', instrumentToken: 43001 } })]),
  )
  const err = await refusal(new LiveRail(h.db, []), close)
  assert.ok(err instanceof LiveRailBlocked)
  assert.equal(h.routed.length, 0)
})

test('a book read that THROWS refuses rather than routes', async () => {
  // The same property `liveAllowlistFromStrategies` holds: an unreachable
  // Mongo must never read as "no restriction".
  const h = db(liveBook([leg()]), { throws: true })
  const err = await refusal(new LiveRail(h.db, []), close)
  assert.ok(err instanceof LiveRailBlocked)
  assert.equal(h.routed.length, 0)
})

// ------------------------------------------- the package-blind smuggle shapes

/**
 * THE TWO SHAPES A SIZE TEST ALONE CANNOT SEE, asserted AT THE RAIL.
 *
 * Gate 1 (`gateStrategy` + `applyActions`) refuses both of these today. That is
 * exactly why they are tested here instead: this rail is the SECOND of two
 * independent gates, and its whole justification is the case where the first
 * one does not hold. A test that reached these through `applyDecision` would be
 * testing gate 1 and calling it a rail property.
 *
 * Both fills below trade in the closing direction, at or under the held size,
 * against a leg the pre-decision book really does hold. On direction and size
 * alone they are indistinguishable from an exit. The OP is what separates them.
 */
test('a ROLL is refused whole — both halves, not just the replacement', async () => {
  // `applyActions` stamps BOTH fills of a roll `op: 'roll'`: the buy-back of
  // the old leg AND the sale of the replacement, which carries the old leg's
  // tag. Letting the buy-back through and refusing the sale would leave a
  // switched-off book short a hedge — worse than leaving it untouched.
  const buyBack: Fill = {
    op: 'roll', deskTag: 'CE420#0', tradingsymbol: SYMBOL, side: 'Buy', qty: 13125, price: 11, ts: 1,
  }
  const h = db(liveBook([leg()]))
  const err = await refusal(new LiveRail(h.db, []), buyBack)
  assert.ok(err instanceof LiveRailBlocked, 'a roll never carries the exemption')
  assert.equal(h.routed.length, 0)
})

test('an OPEN wearing a close\'s clothes is refused on its OP, not its numbers', async () => {
  /**
   * The `[close X, open ts='X' opposite side, qty <= held]` package. This
   * rail's read is of the book BEFORE the decision, so the leg the second
   * action names is still there; the fill trades the closing side at a
   * permitted size. Every number says "exit". It is an open.
   */
  const disguised: Fill = {
    op: 'open', deskTag: 'CE420#0', tradingsymbol: SYMBOL, side: 'Buy', qty: 13125, price: 11, ts: 1,
  }
  const h = db(liveBook([leg()]))
  const err = await refusal(new LiveRail(h.db, []), disguised)
  assert.ok(err instanceof LiveRailBlocked)
  assert.match(err.message, /ADD exposure/)
  assert.equal(h.routed.length, 0)

  // And the identical numbers under `op: 'close'` DO route — so what refused
  // the order above was the op and nothing else.
  const honest = db(liveBook([leg()]))
  await new LiveRail(honest.db, []).route({ ...disguised, op: 'close' }, ctx)
  assert.equal(honest.routed.length, 1)
})
